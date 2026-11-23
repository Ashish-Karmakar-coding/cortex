import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, VERSION } from './version.js';

const GITHUB = `https://github.com/${REPO}`;

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function getInstalledBundlePath(): string {
  const home = process.env['CORTEX_HOME'] ?? join(homedir(), '.cortex');
  return join(home, 'bin', 'cortex.js');
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'cortex-cli',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { tag_name?: string };
    return data.tag_name ? data.tag_name.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

function printManualInstructions(): void {
  console.log('\nUpdate manually with one of:');
  console.log(
    `  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`
  );
  console.log(
    `  irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex`
  );
}

export async function upgrade(): Promise<boolean> {
  const bundlePath = fileURLToPath(import.meta.url);
  const targetPath = getInstalledBundlePath();

  if (!samePath(bundlePath, targetPath) || !existsSync(targetPath)) {
    console.log(`Cortex is running from ${bundlePath}`);
    console.log('Automatic updates only apply to the standalone install in ~/.cortex.');
    printManualInstructions();
    return false;
  }

  console.log(`Current version: v${VERSION}`);

  const latest = await fetchLatestVersion();
  if (latest && latest === VERSION) {
    console.log('Cortex is already up to date.');
    return true;
  }
  if (latest) {
    console.log(`Latest version:  v${latest}`);
  }

  const url = `${GITHUB}/releases/latest/download/cortex.js`;
  console.log(`Downloading ${url}`);

  let bundle: string;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    bundle = await response.text();
  } catch (err) {
    console.error(`\nDownload failed: ${err instanceof Error ? err.message : String(err)}`);
    printManualInstructions();
    return false;
  }

  // Basic sanity check so an HTML error page never overwrites the CLI.
  if (!bundle.startsWith('#!') || bundle.length < 50_000) {
    console.error('\nThe downloaded file does not look like a Cortex bundle.');
    printManualInstructions();
    return false;
  }

  const tempPath = `${targetPath}.new`;
  try {
    writeFileSync(tempPath, bundle, 'utf-8');
    renameSync(tempPath, targetPath);
  } catch (err) {
    console.error(`\nCould not replace ${targetPath}: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Close any running Cortex processes and try again.');
    printManualInstructions();
    return false;
  }

  console.log(`\nUpdated to v${latest ?? 'latest'}. Restart Cortex to use the new version.`);
  return true;
}
