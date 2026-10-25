export class TTSError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TTSError';
  }
}
