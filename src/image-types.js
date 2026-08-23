export const IMAGE_TYPES = Object.freeze({
    jpg: {
        mime: ['image/jpeg'],
        icon: '../assets/icons/jpeg.png'
    },
    png: {
        mime: ['image/png'],
        icon: '../assets/icons/png.png'
    },
    bmp: {
        mime: ['image/bmp', 'image/x-ms-bmp'],
        icon: '../assets/icons/bmp.png'
    },
    webp: {
        mime: ['image/webp'],
        icon: '../assets/icons/webp.png'
    },
    gif: {
        mime: ['image/gif'],
        icon: '../assets/icons/gif.png'
    },
    svg: {
        mime: ['image/svg+xml'],
        icon: '../assets/icons/svg.png'
    },
    avif: {
        mime: ['image/avif'],
        icon: '../assets/icons/avif.png'
    }
});

export function getImageType(mime) {
    const key = mime.split(';')[0].trim().toLowerCase();
    return Object.entries(IMAGE_TYPES).find(([_, type]) => type.mime.includes(key))?.[0] ?? null;
}