chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== 'downloadImage' ||
        typeof message.url !== 'string' ||
        !message.url.trim()) {
        return undefined;
    }

    const options = message.options && typeof message.options === 'object'
        ? message.options
        : {};

    chrome.downloads.download({
        url: message.url.trim(),
        ...options
    }).then(
        (downloadId) => sendResponse({success: true, downloadId}),
        (error) => sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        })
    );

    return true;
});
