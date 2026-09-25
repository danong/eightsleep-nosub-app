import { APP_API_URL, API_HEADERS, CLIENT_API_URL } from "./constants.ts";
import { loginRequest, refreshRequest } from "./auth.ts";
import { EightApiError, type BedSide, type EightToken, type HeatingStatus } from "./types.ts";

export type { BedSide, EightToken, HeatingStatus } from "./types.ts";
export { EightApiError } from "./types.ts";

export interface EightClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type UserProfile = { user: { devices: string[]; currentDevice: { side: string } } };
type DeviceResult = {
  result: {
    leftHeatingLevel: number;
    leftTargetHeatingLevel: number;
    leftNowHeating: boolean;
    leftHeatingDuration: number;
    rightHeatingLevel: number;
    rightTargetHeatingLevel: number;
    rightNowHeating: boolean;
    rightHeatingDuration: number;
  };
};

export class EightClient {
  private readonly requestFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EightClientOptions = {}) {
    this.requestFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  login(email: string, password: string): Promise<EightToken> {
    return loginRequest(this.request.bind(this), email, password);
  }

  refresh(refreshToken: string, userId: string): Promise<EightToken> {
    return refreshRequest(this.request.bind(this), refreshToken, userId);
  }

  async getHeatingStatus(token: EightToken): Promise<HeatingStatus> {
    const profile = await this.getJson<UserProfile>(`${CLIENT_API_URL}/users/me`, token);
    const deviceId = profile.user.devices[0];
    if (!deviceId) throw new EightApiError("No Eight Sleep device is linked to this account");
    const rawSide = profile.user.currentDevice.side;
    if (rawSide !== "solo" && rawSide !== "left" && rawSide !== "right") {
      throw new EightApiError(`Unsupported bed side: ${rawSide}`);
    }
    const device = await this.getJson<DeviceResult>(
      `${CLIENT_API_URL}/devices/${encodeURIComponent(deviceId)}`,
      token,
    );
    // Preserve the existing client's behavior: it selects left only for "left"
    // and uses the right telemetry channel otherwise, including "solo".
    const side = rawSide === "left" ? "left" : "right";
    const selected =
      side === "left"
        ? {
            heatingLevel: device.result.leftHeatingLevel,
            targetHeatingLevel: device.result.leftTargetHeatingLevel,
            isHeating: device.result.leftNowHeating,
            heatingDuration: device.result.leftHeatingDuration,
          }
        : {
            heatingLevel: device.result.rightHeatingLevel,
            targetHeatingLevel: device.result.rightTargetHeatingLevel,
            isHeating: device.result.rightNowHeating,
            heatingDuration: device.result.rightHeatingDuration,
          };
    return {
      side: rawSide,
      ...selected,
    };
  }

  turnOn(token: EightToken, userId = token.userId): Promise<void> {
    return this.putTemperature(token, userId, { currentState: { type: "smart" } });
  }

  turnOff(token: EightToken, userId = token.userId): Promise<void> {
    return this.putTemperature(token, userId, { currentState: { type: "off" } });
  }

  async setLevel(
    token: EightToken,
    userId: string,
    level: number,
    durationSeconds = 0,
  ): Promise<void> {
    if (!Number.isInteger(level) || level < -100 || level > 100) {
      throw new RangeError("Heating level must be an integer from -100 to 100");
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new RangeError("Heating duration must be a non-negative number of seconds");
    }
    await this.putTemperature(token, userId, {
      timeBased: { level, durationSeconds },
      currentLevel: level,
    });
  }

  private async putTemperature(token: EightToken, userId: string, body: unknown): Promise<void> {
    await this.getJson(`${APP_API_URL}/users/${encodeURIComponent(userId)}/temperature`, token, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  private async getJson<T = unknown>(
    url: string,
    token: EightToken,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.request(url, {
      ...init,
      headers: { ...API_HEADERS, ...init.headers, authorization: `Bearer ${token.accessToken}` },
    });
    if (!response.ok)
      throw new EightApiError(`Eight Sleep API failed (${response.status})`, response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    // Retry one transient failure for reads only. Mutations are never replayed.
    const attempts = (init.method ?? "GET").toUpperCase() === "GET" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.requestFetch(url, { ...init, signal: controller.signal });
        if (response.status < 500 || attempt === attempts - 1) return response;
        lastError = new EightApiError(
          `Eight Sleep API failed (${response.status})`,
          response.status,
        );
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new EightApiError("Eight Sleep request failed");
  }
}
