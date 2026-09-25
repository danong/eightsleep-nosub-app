import { AUTH_URL, API_HEADERS, CLIENT_ID, CLIENT_SECRET } from "./constants.ts";
import { EightApiError, type EightToken } from "./types.ts";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  userId?: string;
};

export async function loginRequest(
  request: (url: string, init: RequestInit) => Promise<Response>,
  email: string,
  password: string,
): Promise<EightToken> {
  const data = await tokenRequest(request, {
    grant_type: "password",
    username: email,
    password,
  });
  if (!data.userId) throw new EightApiError("Eight Sleep login returned no user id");
  return toToken(data, data.userId);
}

export async function refreshRequest(
  request: (url: string, init: RequestInit) => Promise<Response>,
  refreshToken: string,
  userId: string,
): Promise<EightToken> {
  const data = await tokenRequest(request, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return toToken(data, userId);
}

async function tokenRequest(
  request: (url: string, init: RequestInit) => Promise<Response>,
  grant: Record<string, string>,
): Promise<TokenResponse> {
  const response = await request(AUTH_URL, {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...grant }),
  });
  if (!response.ok) {
    throw new EightApiError(
      response.status === 401
        ? "Invalid Eight Sleep credentials or refresh token"
        : `Eight Sleep auth failed (${response.status})`,
      response.status,
    );
  }
  const value: unknown = await response.json();
  if (!isTokenResponse(value))
    throw new EightApiError("Eight Sleep returned an invalid token response");
  return value;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.access_token === "string" &&
    typeof data.refresh_token === "string" &&
    typeof data.expires_in === "number" &&
    (data.userId === undefined || typeof data.userId === "string")
  );
}

function toToken(data: TokenResponse, userId: string): EightToken {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    userId,
  };
}
