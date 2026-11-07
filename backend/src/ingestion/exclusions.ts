/**
 * Folder exclusion rules. Patterns use a gitignore-like glob syntax:
 *   - `name`        matches a file or directory called `name` at any depth
 *   - `dir/`        matches a directory only
 *   - `a/b/*.md`    patterns containing `/` are anchored to the project root
 *   - `*`, `**`, `?` behave as in shells/globstar
 */

export const DEFAULT_EXCLUSIONS: Record<string, string[]> = {
  dependencies: [
    "node_modules/", "bower_components/", "vendor/", ".venv/", "venv/", "env/", "__pycache__/", "site-packages/",
    "Pods/", "Carthage/", ".gradle/", "target/", ".bundle/", "deps/", "_build/", "elm-stuff/",
  ],
  versionControl: [".git/", ".svn/", ".hg/"],
  generated: [
    "dist/", "build/", "out/", ".next/", ".nuxt/", ".svelte-kit/", "coverage/", ".cache/", ".parcel-cache/",
    ".turbo/", "DerivedData/", "*.min.js", "*.min.css", "*.map", "*.lock", "package-lock.json", "yarn.lock",
    "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "*.pyc", "*.class", "*.o", "*.so", "*.dylib", "*.dll", "*.exe",
    ".ipynb_checkpoints/",
  ],
  temporary: ["*.tmp", "*.temp", "*.swp", "*.swo", "*~", ".DS_Store", "Thumbs.db", "*.log", "tmp/", "temp/"],
  credentials: [
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "id_rsa*", "id_ed25519*",
    "credentials*", "*secret*", ".npmrc", ".pypirc", ".netrc", "*.kdbx", ".aws/", ".ssh/", ".gnupg/",
    "*.mobileprovision", "service-account*.json",
  ],
  ideAndOs: [".idea/", ".vscode/", "*.xcuserstate", "xcuserdata/"],
};

export const ALL_DEFAULT_EXCLUSIONS = Object.values(DEFAULT_EXCLUSIONS).flat();

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories, a trailing `**` matches everything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

interface CompiledPattern {
  source: string;
  regex: RegExp;
  dirOnly: boolean;
  anchored: boolean;
  negated: boolean;
}

export class ExclusionMatcher {
  private readonly patterns: CompiledPattern[];

  constructor(patterns: string[]) {
    this.patterns = patterns
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("#"))
      .map((raw) => {
        let p = raw;
        const negated = p.startsWith("!");
        if (negated) p = p.slice(1);
        const dirOnly = p.endsWith("/");
        if (dirOnly) p = p.slice(0, -1);
        const anchored = p.includes("/");
        if (p.startsWith("/")) p = p.slice(1);
        return { source: raw, regex: globToRegExp(p), dirOnly, anchored, negated };
      });
  }

  /**
   * Returns the pattern that excludes `relPath` (posix separators), or null when the path is allowed.
   * A path is excluded if it or any of its parent directories matches.
   */
  match(relPath: string, isDir: boolean): string | null {
    const parts = relPath.split("/").filter(Boolean);
    let excludedBy: string | null = null;
    for (const pat of this.patterns) {
      for (let depth = 1; depth <= parts.length; depth++) {
        const isLeaf = depth === parts.length;
        const candidateIsDir = isLeaf ? isDir : true;
        if (pat.dirOnly && !candidateIsDir) continue;
        const subject = pat.anchored ? parts.slice(0, depth).join("/") : parts[depth - 1]!;
        if (pat.regex.test(subject)) {
          excludedBy = pat.negated ? null : pat.source;
          break;
        }
      }
    }
    return excludedBy;
  }
}

/** Reads a project's top-level .gitignore so user conventions are respected. */
export function parseGitignore(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
