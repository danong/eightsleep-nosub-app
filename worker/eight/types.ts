export type BedSide = "solo" | "left" | "right";

export interface EightToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

export interface HeatingStatus {
  side: BedSide;
  heatingLevel: number;
  isHeating: boolean;
  heatingDuration: number;
  targetHeatingLevel: number;
}

export class EightApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EightApiError";
    this.status = status;
  }
}
