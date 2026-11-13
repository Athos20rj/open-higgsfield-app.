"use server";

import { cookies } from "next/headers";

import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import {
  MissingCredentialsError,
  PLATFORM_KEY_COOKIE,
  PLATFORM_KEY_COOKIE_OPTIONS,
  decodeCredentials,
  encodeCredentials,
  parseCredentialInput,
} from "./credentials";
import { createPlatformClient, PlatformError } from "./platform";
import type { QueuedGeneration, StatusResult } from "./platform";
import { toPlatform } from "./to-platform";

export async function savePlatformCredentials(data: unknown) {
  const { apiKey } = parseCredentialInput(data);
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, encodeCredentials(apiKey), PLATFORM_KEY_COOKIE_OPTIONS);
}

export async function clearPlatformCredentials() {
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, "", { ...PLATFORM_KEY_COOKIE_OPTIONS, maxAge: 0 });
}

export async function hasPlatformCredentials() {
  return (await readStoredCredentials()) !== null;
}

/** Return expected API failures as data, not redacted React error 441. */
type SubmitResult =
  | { ok: true; queued: QueuedGeneration }
  | { ok: false; error: string; reconnect: boolean };

export async function submitGeneration(plane: GenerationPlane): Promise<SubmitResult> {
  try {
    const model = getModel(plane.model);
    const parsed: GenerationPlane = {
      ...plane,
      settings: parseSettings(model, plane.settings),
    };
    const { path, body } = toPlatform(parsed);
    const queued = await createPlatformClient(await readCredentials()).submit(path, body);
    return { ok: true, queued };
  } catch (caught) {
    // Do not return keys, raw API payloads, request bodies or error stacks.
    if (caught instanceof PlatformError) {
      console.warn("[generation] API rejected request", { status: caught.status });
    } else {
      console.warn("[generation] Unable to submit request", {
        type: caught instanceof Error ? caught.name : "unknown",
      });
    }
    return {
      ok: false,
      error: explainSubmitError(caught),
      reconnect: caught instanceof MissingCredentialsError ||
        (caught instanceof PlatformError && (caught.status === 401 || caught.status === 403)),
    };
  }
}

function explainSubmitError(caught: unknown): string {
  if (caught instanceof MissingCredentialsError) {
    return "Sua chave de API não está conectada. Toque no ícone de chave para adicioná-la.";
  }
  if (caught instanceof PlatformError) {
    if (caught.status === 401 || caught.status === 403) {
      return "A Higgsfield recusou a chave de API (HTTP " + caught.status + "). Verifique a chave na plataforma oficial.";
    }
    if (caught.status === 402) {
      return "A Higgsfield recusou a geração por saldo insuficiente (HTTP 402). Consulte o saldo da API antes de tentar novamente.";
    }
    if (caught.status === 429) {
      return "A Higgsfield atingiu o limite de requisições (HTTP 429). Aguarde antes de tentar novamente.";
    }
    if (caught.status === 400 || caught.status === 422) {
      const body = caught.body;
      const detail = body && typeof body === "object" && !Array.isArray(body) &&
        typeof (body as { detail?: unknown }).detail === "string"
          ? (body as { detail: string }).detail.replace(/[\\r\\n]+/g, " ").slice(0, 220)
          : "";
      return "O modelo não aceitou essa configuração (HTTP " + caught.status + "). " +
        (detail || "Confira modelo, duração e resolução.");
    }
    if (caught.status >= 500) {
      return "O serviço Higgsfield está indisponível no momento (HTTP " + caught.status + ").";
    }
    return "A Higgsfield recusou a solicitação (HTTP " + caught.status + "). Consulte o painel da API.";
  }
  if (caught instanceof TypeError) {
    return "Não foi possível conectar ao servidor da Higgsfield. Verifique os registros na Vercel.";
  }
  return "Não foi possível enviar a geração. Consulte os registros do aplicativo na Vercel.";
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. */
export async function getGenerationStatuses(data: unknown): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data);
  let client: ReturnType<typeof createPlatformClient>;
  try {
    client = createPlatformClient(await readCredentials());
  } catch (caught) {
    return requestIds.map((requestId) => ({ requestId, error: explainSubmitError(caught) }));
  }
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await client.status(requestId) };
      } catch (caught) {
        return { requestId, error: explainSubmitError(caught) };
      }
    }),
  );
}

async function readStoredCredentials() {
  const jar = await cookies();
  return decodeCredentials(jar.get(PLATFORM_KEY_COOKIE)?.value);
}

async function readCredentials() {
  const stored = await readStoredCredentials();
  if (!stored) throw new MissingCredentialsError();
  // The official Higgsfield API works without manual Vercel configuration.
  const baseUrl = process.env.HF_API_BASE_URL?.trim() || "https://api.higgsfield.ai";
  return { ...stored, baseUrl };
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return requestId;
  });
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}
