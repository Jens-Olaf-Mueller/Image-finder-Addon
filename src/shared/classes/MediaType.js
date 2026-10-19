const MEDIA_TYPES = Object.freeze({
    image: Object.freeze({
        jpg: Object.freeze({
            mime: Object.freeze(['image/jpeg']),
            aliases: Object.freeze(['jpg', 'jpeg']),
            icon: '../assets/icons/jpeg.png'
        }),
        png: Object.freeze({
            mime: Object.freeze(['image/png']),
            aliases: Object.freeze(['png']),
            icon: '../assets/icons/png.png'
        }),
        bmp: Object.freeze({
            mime: Object.freeze(['image/bmp', 'image/x-ms-bmp']),
            aliases: Object.freeze(['bmp']),
            icon: '../assets/icons/bmp.png'
        }),
        webp: Object.freeze({
            mime: Object.freeze(['image/webp']),
            aliases: Object.freeze(['webp']),
            icon: '../assets/icons/webp.png'
        }),
        gif: Object.freeze({
            mime: Object.freeze(['image/gif']),
            aliases: Object.freeze(['gif']),
            icon: '../assets/icons/gif.png'
        }),
        svg: Object.freeze({
            mime: Object.freeze(['image/svg+xml']),
            aliases: Object.freeze(['svg']),
            icon: '../assets/icons/svg.png'
        }),
        avif: Object.freeze({
            mime: Object.freeze(['image/avif']),
            aliases: Object.freeze(['avif']),
            icon: '../assets/icons/avif.png'
        })
    }),
    video: Object.freeze({}),
    audio: Object.freeze({})
});

/**
 * @file MediaType.js
 * @module MediaType
 * @version 0.1.12
 * @date 2026-10-06
 * @author Jens-Olaf-Mueller
 *
 * MediaType - Resolves supported media MIME types and formats.
 * ===============================================================
 *
 * Encapsulates media format metadata for the current image scanner and the
 * planned video and audio scanners. The immutable registry remains private;
 * callers receive a normalized descriptor through the single public API.
 * - Key features:
 * - Image formats:              Resolves supported image MIME types and aliases.
 * - Extensible registry:        Reserves type groups for video and audio formats.
 * - Immutable descriptors:      Prevents callers from changing type metadata.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link getType}             - Resolves a supported media type descriptor.
 */
export class MediaType {
    // ✴️ NEW 2026-10-06: Central media type registry for images, video, and audio.
    static #mediaTypes = MEDIA_TYPES;

    /**
     * Resolves a supported media MIME type or format alias to its descriptor.
     *
     * @param {string} mime - The MIME type with optional parameters, or a format alias.
     * @returns {{type: string, format: string, mime: readonly string[], icon: string}|null}
     * A normalized immutable descriptor, or null when unsupported.
     */
    static getType(mime) {
        if (typeof mime !== 'string') return null;

        const normalizedMime = mime.split(';')[0].trim().toLowerCase();
        if (!normalizedMime) return null;

        for (const [type, formats] of Object.entries(MediaType.#mediaTypes)) {
            for (const [format, details] of Object.entries(formats)) {
                if (!details.mime.includes(normalizedMime) &&
                    !details.aliases.includes(normalizedMime)) {
                    continue;
                }

                return Object.freeze({
                    type,
                    format,
                    mime: details.mime,
                    icon: details.icon
                });
            }
        }

        return null;
    }
};