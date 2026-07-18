export declare const SYSTEMD_RUNTIME_DIR: string
export declare function guardVerdict(input: {
  override: boolean
  systemd: boolean
  probe?: {
    status?: number | null
    stdout?: string
    error?: Error
    signal?: string | null
  }
}): { code: number; message?: string }
