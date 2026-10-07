import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const manifestPath = resolve(dirname(scriptPath), '..', 'manifest.json');
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function incrementPatchVersion(version) {
    const match = VERSION_PATTERN.exec(version);
    if (!match) {
        throw new Error(`Expected a three-part numeric version, received: ${version}`);
    }

    const [major, minor, patch] = match.slice(1).map(Number);
    if (patch >= 65535) throw new Error('The manifest patch version cannot exceed 65535');

    return `${major}.${minor}.${patch + 1}`;
}

export function withIncrementedManifestVersion(manifest) {
    const version = incrementPatchVersion(manifest.version);

    return {
        ...manifest,
        version,
        version_name: `Beta ${version}`
    };
}

async function main() {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const updatedManifest = withIncrementedManifestVersion(manifest);

    await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 4)}\n`);
    console.log(`Manifest version updated to ${updatedManifest.version_name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
    main().catch((error) => {
        console.error(`Cannot update manifest version: ${error.message}`);
        process.exitCode = 1;
    });
}