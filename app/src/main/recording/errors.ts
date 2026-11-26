// A stable code lets telemetry tag app-thrown refusals without uploading the localized message.
export function recordingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
