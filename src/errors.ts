export class VisionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VisionError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof VisionError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
