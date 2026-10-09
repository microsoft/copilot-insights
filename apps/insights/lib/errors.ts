export class AppError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
