export class ServiceError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status }
}
export const notFound = () => new ServiceError('not-found', 404)
export const conflict = (code = 'revision-conflict') => new ServiceError(code, 409)
