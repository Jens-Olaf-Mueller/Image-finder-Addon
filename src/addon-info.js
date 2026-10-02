export function getAddonVersionName() {
    try {
        const manifest = globalThis.chrome?.runtime?.getManifest?.();
        const versionName = String(manifest?.version_name ?? '').trim();

        if (versionName) return versionName;

        const version = String(manifest?.version ?? '').trim();
        return version || 'Version unavailable';
    } catch {
        return 'Version unavailable';
    }
}
