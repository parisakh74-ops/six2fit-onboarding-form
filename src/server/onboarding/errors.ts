/** Failure of a persistence port. Messages and codes never contain answers, tokens or credentials. */
export class StoreError extends Error {
  constructor(
    public readonly kind: "UNAVAILABLE" | "CORRUPT" | "NOT_CONFIGURED" | "REJECTED" | "TOO_LARGE",
    message: string,
    /** Safe machine code. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "StoreError";
  }

  /** True only when the failure proves that nothing was written to the CRM (no request sent, or a definitive refusal). */
  public notWritten = false;
}
