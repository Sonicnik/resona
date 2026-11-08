import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Credentials the app can hold. Each maps to the environment variable the SDK/connectors read. */
export const CREDENTIALS = {
  anthropic: "ANTHROPIC_API_KEY",
  github: "GITHUB_TOKEN",
  x: "X_BEARER_TOKEN",
} as const;
export type CredentialName = keyof typeof CREDENTIALS;

export interface SecretStore {
  get(name: CredentialName): Promise<string | null>;
  set(name: CredentialName, value: string): Promise<void>;
  delete(name: CredentialName): Promise<void>;
}

const SERVICE = "Resona";

/** macOS login Keychain via the built-in `security` CLI. Values never touch the database, vault or logs. */
export class KeychainStore implements SecretStore {
  async get(name: CredentialName): Promise<string | null> {
    try {
      const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
      return stdout.trim() || null;
    } catch {
      return null; // not found, or not on macOS
    }
  }
  async set(name: CredentialName, value: string): Promise<void> {
    // shortcut: `-w <value>` is briefly visible to local `ps`; upgrade to a native Keychain API in the Tauri app.
    await run("/usr/bin/security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-l", `${SERVICE} ${name}`, "-w", value]);
  }
  async delete(name: CredentialName): Promise<void> {
    await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", name]).catch(() => {});
  }
}

export class MemoryStore implements SecretStore {
  readonly values = new Map<CredentialName, string>();
  async get(name: CredentialName) {
    return this.values.get(name) ?? null;
  }
  async set(name: CredentialName, value: string) {
    this.values.set(name, value);
  }
  async delete(name: CredentialName) {
    this.values.delete(name);
  }
}

/** Loads stored credentials into the environment unless the environment already sets them. */
export async function loadCredentials(store: SecretStore): Promise<void> {
  for (const [name, envVar] of Object.entries(CREDENTIALS) as Array<[CredentialName, string]>) {
    if (process.env[envVar]) continue;
    const value = await store.get(name);
    if (value) process.env[envVar] = value;
  }
}

export type Chooser = (kind: "folder" | "file", prompt: string) => Promise<string | null>;

/** Native Finder dialog on this Mac. The prompt is passed as an argv item, never spliced into the script. */
export const macChooser: Chooser = async (kind, prompt) => {
  const script = [
    "on run argv",
    `  return POSIX path of (choose ${kind === "folder" ? "folder" : "file"} with prompt (item 1 of argv))`,
    "end run",
  ].join("\n");
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script, prompt], { timeout: 10 * 60_000 });
    return stdout.trim().replace(/(.)\/$/, "$1") || null;
  } catch (err) {
    // osascript exits with "User canceled. (-128)" when the dialog is dismissed.
    if (String((err as { stderr?: string }).stderr ?? err).includes("-128")) return null;
    throw err;
  }
};
