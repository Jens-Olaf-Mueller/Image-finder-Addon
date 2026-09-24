const DEFAULT_MINIMUM_IMAGE_WIDTH = 200;
const DEFAULT_MINIMUM_IMAGE_HEIGHT = 200;
const DEFAULT_MAX_SEARCH_DEPTH = 6;
const DEFAULT_MAX_SEARCH_NODES = 320;
const DEFAULT_MAX_ROWS = 160;

const INBOX_TERMS = new Set([
    'chat', 'chats', 'message', 'messages', 'user', 'users', 'avatar', 'conversation',
    'conversations', 'inbox', 'dialogue', 'dialog', 'thread', 'threads', 'contact', 'contacts',
    'direct', 'dm'
]);
const MENU_TERMS = new Set([
    'menu', 'navigation', 'nav', 'sidebar', 'toolbar', 'toolbox', 'actionbar', 'tab', 'tabs'
]);
const CONTENT_TERMS = new Set([
    'media', 'gallery', 'carousel', 'slide', 'slides', 'poster', 'picture', 'content'
]);
const BADGE_TERMS = new Set([
    'badge', 'status', 'counter', 'count', 'unread', 'notification', 'notifications', 'online',
    'new'
]);
const STRUCTURE_CONTAINER_TERMS = new Set([
    'list', 'listbox', 'inbox', 'dialogue', 'dialogues', 'conversation', 'conversations',
    'message', 'messages', 'chat', 'chats', 'profile', 'profiles', 'thread', 'threads',
    'contact', 'contacts', 'menu', 'navigation'
]);

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));
const rounded = (value) => Math.max(0, Math.round(Number(value) || 0));
const ratio = (part, total) => total > 0 ? part / total : 0;

/**
 * Inspects a DOM container without producing scanner-specific candidate objects.
 * The returned observations are intentionally explicit so that callers can apply
 * their own priority policy while keeping the structural evidence inspectable.
 */
export class ContainerAnalyser {
    static analyze(container, {
        minimumImageWidth = DEFAULT_MINIMUM_IMAGE_WIDTH,
        minimumImageHeight = DEFAULT_MINIMUM_IMAGE_HEIGHT,
        maxSearchDepth = DEFAULT_MAX_SEARCH_DEPTH,
        maxSearchNodes = DEFAULT_MAX_SEARCH_NODES,
        maxRows = DEFAULT_MAX_ROWS
    } = {}) {
        if (!ContainerAnalyser.isElement(container)) {
            return ContainerAnalyser.getEmptyAnalysis();
        }

        const normalizedMinimumWidth = Math.max(0, rounded(minimumImageWidth));
        const normalizedMinimumHeight = Math.max(0, rounded(minimumImageHeight));
        const scrollInfo = ContainerAnalyser.getScrollInfo(container);
        const imageAnalysis = ContainerAnalyser.analyzeImages(container, {
            minimumImageWidth: normalizedMinimumWidth,
            minimumImageHeight: normalizedMinimumHeight
        });
        const rowSearch = ContainerAnalyser.findRepeatedRowGroup(container, {
            maxSearchDepth,
            maxSearchNodes,
            maxRows
        });
        const rowAnalysis = ContainerAnalyser.analyzeRows(rowSearch.rows, {
            maxRows,
            minimumImageWidth: normalizedMinimumWidth,
            minimumImageHeight: normalizedMinimumHeight
        });
        const semanticAnalysis = ContainerAnalyser.analyzeSemantics(container);

        const hasRepeatedRows = rowSearch.rowCount >= 4 && rowSearch.rowSimilarity >= .7;
        const hasNavigationLandmark = ContainerAnalyser.hasNavigationLandmark(container);
        const hasContentLandmark = ContainerAnalyser.hasContentLandmark(container);
        const links = container.querySelectorAll('a').length;
        const buttons = container.querySelectorAll('button').length;
        const svgs = container.querySelectorAll('svg').length;
        const videos = container.querySelectorAll('video').length;
        const mediaElements = container.querySelectorAll('picture, source, video').length;
        const positiveSignals = [];
        const negativeSignals = [];
        let navigationStrength = 0;
        let inboxStrength = 0;
        let contentStrength = 0;

        if (hasRepeatedRows) {
            negativeSignals.push(`repeated-rows=${rowSearch.rowCount}`);
            if (imageAnalysis.dominantImageIsSmall && imageAnalysis.dominantImageSizeRatio >= .6) {
                negativeSignals.push(`dominant-small-images=${imageAnalysis.dominantImageSize}`);
            }
        }
        if (hasRepeatedRows && hasNavigationLandmark) {
            navigationStrength += 3;
            negativeSignals.push('navigation-landmark-with-repeated-rows');
        }
        if (hasRepeatedRows && (links + buttons + svgs) >= Math.max(4, rowSearch.rowCount / 2)) {
            navigationStrength += 2;
            negativeSignals.push('repeated-interactive-or-icon-rows');
        }
        if (hasRepeatedRows && imageAnalysis.dominantImageIsSmall &&
            imageAnalysis.dominantImageSizeRatio >= .6) {
            navigationStrength += 1;
        }
        if (hasRepeatedRows && semanticAnalysis.menuSemantics) {
            navigationStrength += 1;
            negativeSignals.push('navigation-structure-token');
        }
        if (hasRepeatedRows && imageAnalysis.dominantImageIsAvatarSized &&
            imageAnalysis.dominantImageSizeRatio >= .6) {
            inboxStrength += 3;
            negativeSignals.push('repeated-avatar-or-thumbnail-rows');
        }
        if (hasRepeatedRows && imageAnalysis.dominantImageIsAvatarSized &&
            semanticAnalysis.inboxSemantics) {
            inboxStrength += 1;
            negativeSignals.push('inbox-structure-token');
        }
        if (hasRepeatedRows && rowAnalysis.textPattern && semanticAnalysis.inboxSemantics) {
            inboxStrength += 1;
            negativeSignals.push('repeated-text-rows');
        }
        if (hasRepeatedRows && rowAnalysis.badgePattern && semanticAnalysis.inboxSemantics) {
            inboxStrength += 1;
            negativeSignals.push('repeated-badge-or-status');
        }
        if (imageAnalysis.largeEnoughImageCount > 0) {
            contentStrength += 2;
            positiveSignals.push(`eligible-images=${imageAnalysis.largeEnoughImageCount}/${imageAnalysis.imageCount}`);
        }
        if (imageAnalysis.distinctImageSizes >= 3) {
            contentStrength += 1;
            positiveSignals.push(`diverse-image-sizes=${imageAnalysis.distinctImageSizes}`);
        }
        if (semanticAnalysis.contentSemantics &&
            (mediaElements > 0 || imageAnalysis.largeEnoughImageCount > 0)) {
            contentStrength += 2;
            positiveSignals.push('media-or-gallery-structure');
        }
        if (videos > 0 || hasContentLandmark) {
            contentStrength += 1;
            positiveSignals.push('content-landmark-or-video');
        }

        const inboxScore = ContainerAnalyser.getInboxScore({
            hasRepeatedRows,
            rowSimilarity: rowSearch.rowSimilarity,
            rowCount: rowSearch.rowCount,
            avatarPattern: imageAnalysis.avatarPattern || rowAnalysis.avatarPattern,
            textPattern: rowAnalysis.textPattern,
            truncationPattern: rowAnalysis.truncationPattern,
            badgePattern: rowAnalysis.badgePattern,
            inboxSemantics: semanticAnalysis.inboxSemantics,
            largeContentImages: imageAnalysis.largeContentImages
        });
        const menuScore = ContainerAnalyser.getMenuScore({
            hasRepeatedRows,
            rowSimilarity: rowSearch.rowSimilarity,
            hasNavigationLandmark,
            menuSemantics: semanticAnalysis.menuSemantics,
            compactImages: imageAnalysis.compactImages,
            interactiveCount: links + buttons + svgs,
            rowCount: rowSearch.rowCount,
            largeContentImages: imageAnalysis.largeContentImages
        });
        const contentScore = ContainerAnalyser.getContentScore({
            largeContentImages: imageAnalysis.largeContentImages,
            largeEnoughImageCount: imageAnalysis.largeEnoughImageCount,
            eligibleImageRatio: imageAnalysis.eligibleImageRatio,
            distinctImageSizes: imageAnalysis.distinctImageSizes,
            contentSemantics: semanticAnalysis.contentSemantics,
            mediaElements,
            videos,
            hasContentLandmark
        });

        let classification = 'unknown';
        if (navigationStrength >= 4 && navigationStrength >= inboxStrength &&
            navigationStrength >= contentStrength) {
            classification = 'navigation';
        } else if (inboxStrength >= 3 && inboxStrength > contentStrength) {
            classification = 'list/inbox';
        } else if (contentStrength >= 2) {
            classification = 'content';
        } else if (navigationStrength > 0 || inboxStrength > 0 || contentStrength > 0) {
            classification = 'mixed';
        }

        const score = classification === 'navigation'
            ? Math.min(10, clampScore(50 + contentStrength * 12 - navigationStrength * 14 - inboxStrength * 9))
            : clampScore(50 + contentStrength * 12 - navigationStrength * 14 - inboxStrength * 9);
        const suggestedAction = classification === 'navigation' ? 'skip' :
            classification === 'list/inbox' ? 'deprioritize' :
                classification === 'content' ? 'scan-first' : 'normal';
        const hasStrongEligibleMedia = imageAnalysis.largeEnoughImageCount >= 3 &&
            (imageAnalysis.eligibleImageRatio >= .35 || imageAnalysis.distinctImageSizes >= 3) &&
            (semanticAnalysis.contentSemantics || mediaElements > 0 || videos > 0 || hasContentLandmark);
        const hasStructuredMediaContent = semanticAnalysis.contentSemantics &&
            (mediaElements > 0 || videos > 0 || imageAnalysis.largeEnoughImageCount >= 3);
        const hasStrongContentSignals = hasStrongEligibleMedia || hasStructuredMediaContent ||
            (hasContentLandmark && imageAnalysis.largeEnoughImageCount >= 3);
        const clearNavigationPattern = classification === 'navigation' && hasRepeatedRows &&
            hasNavigationLandmark && semanticAnalysis.menuSemantics;
        const clearInboxPattern = classification === 'list/inbox' && hasRepeatedRows &&
            imageAnalysis.dominantImageIsAvatarSized && imageAnalysis.dominantImageSizeRatio >= .6 &&
            semanticAnalysis.inboxSemantics;
        const priority = classification === 'content' && hasStrongContentSignals
            ? 'high'
            : (clearNavigationPattern || clearInboxPattern) && !hasStrongContentSignals
                ? 'low'
                : 'medium';

        return {
            scrollable: scrollInfo.scrollable,
            scrollAxis: scrollInfo.scrollAxis,
            verticallyScrollable: scrollInfo.verticallyScrollable,
            horizontallyScrollable: scrollInfo.horizontallyScrollable,
            geometry: scrollInfo.geometry,
            overflowX: scrollInfo.overflowX,
            overflowY: scrollInfo.overflowY,
            flexDirection: scrollInfo.flexDirection,

            repeatedRows: hasRepeatedRows,
            rowCount: rowSearch.rowCount,
            rowSimilarity: rowSearch.rowSimilarity,
            repeatedStructureRatio: rowSearch.rowSimilarity,
            similarRowCount: rowSearch.similarRowCount,
            rowGroupTag: rowSearch.rowGroupTag,
            rowGroupIdentifier: rowSearch.rowGroupIdentifier,
            rowGroupDepth: rowSearch.rowGroupDepth,

            compactImages: imageAnalysis.compactImages,
            avatarPattern: imageAnalysis.avatarPattern || rowAnalysis.avatarPattern,
            textPattern: rowAnalysis.textPattern,
            truncationPattern: rowAnalysis.truncationPattern,
            badgePattern: rowAnalysis.badgePattern,
            inboxSemantics: semanticAnalysis.inboxSemantics,
            menuSemantics: semanticAnalysis.menuSemantics,
            contentSemantics: semanticAnalysis.contentSemantics,
            semanticMatches: semanticAnalysis.matches,

            largeContentImages: imageAnalysis.largeContentImages,
            imageCount: imageAnalysis.imageCount,
            renderedImageCount: imageAnalysis.renderedImageCount,
            compactImageCount: imageAnalysis.compactImageCount,
            avatarLikeImageCount: imageAnalysis.avatarLikeImageCount,
            largeContentImageCount: imageAnalysis.largeContentImageCount,
            relevantImageCount: imageAnalysis.largeEnoughImageCount,
            smallImageCount: imageAnalysis.smallImageCount,
            largeEnoughImageCount: imageAnalysis.largeEnoughImageCount,
            eligibleImageRatio: imageAnalysis.eligibleImageRatio,
            dominantImageSize: imageAnalysis.dominantImageSize,
            dominantImageSizeRatio: imageAnalysis.dominantImageSizeRatio,
            distinctImageSizes: imageAnalysis.distinctImageSizes,
            imageGeometry: imageAnalysis.imageGeometry,

            textRowCount: rowAnalysis.textRowCount,
            truncatedTextRowCount: rowAnalysis.truncatedTextRowCount,
            badgeRowCount: rowAnalysis.badgeRowCount,
            avatarRowCount: rowAnalysis.avatarRowCount,
            textRowRatio: rowAnalysis.textRowRatio,
            truncatedTextRowRatio: rowAnalysis.truncatedTextRowRatio,
            badgeRowRatio: rowAnalysis.badgeRowRatio,

            inboxScore,
            menuScore,
            contentScore,
            classification,
            classificationKind: classification === 'list/inbox' ? 'inbox' : classification,
            priority,
            score,
            suggestedAction,
            links,
            buttons,
            svgs,
            mediaSignals: mediaElements + videos + Number(semanticAnalysis.contentSemantics),
            positiveSignals,
            negativeSignals
        };
    }

    static getScrollInfo(element) {
        const geometry = ContainerAnalyser.getGeometry(element);
        let style = null;
        try {
            style = getComputedStyle(element);
        } catch {
            // Detached or cross-document elements are represented by their geometry alone.
        }

        const overflowX = style?.overflowX ?? '(unavailable)';
        const overflowY = style?.overflowY ?? '(unavailable)';
        const canOverflowX = /(?:auto|scroll|overlay)/i.test(overflowX);
        const canOverflowY = /(?:auto|scroll|overlay)/i.test(overflowY);
        const horizontallyScrollable = geometry.clientWidth > 0 &&
            geometry.scrollWidth > geometry.clientWidth + 1 && canOverflowX;
        const verticallyScrollable = geometry.clientHeight > 0 &&
            geometry.scrollHeight > geometry.clientHeight + 1 && canOverflowY;

        return {
            geometry,
            overflowX,
            overflowY,
            flexDirection: style?.flexDirection ?? '(unavailable)',
            horizontallyScrollable,
            verticallyScrollable,
            scrollable: horizontallyScrollable || verticallyScrollable,
            scrollAxis: horizontallyScrollable && verticallyScrollable
                ? 'both'
                : verticallyScrollable
                    ? 'y'
                    : horizontallyScrollable
                        ? 'x'
                        : 'none'
        };
    }

    static getGeometry(element) {
        let rect = null;
        try {
            rect = element?.getBoundingClientRect?.() ?? null;
        } catch {
            // Geometry falls back to DOM dimensions below.
        }

        return {
            top: rounded(rect?.top),
            right: rounded(rect?.right),
            bottom: rounded(rect?.bottom),
            left: rounded(rect?.left),
            width: rounded(rect?.width || element?.clientWidth || element?.offsetWidth),
            height: rounded(rect?.height || element?.clientHeight || element?.offsetHeight),
            clientWidth: rounded(element?.clientWidth),
            clientHeight: rounded(element?.clientHeight),
            scrollWidth: rounded(element?.scrollWidth),
            scrollHeight: rounded(element?.scrollHeight),
            scrollTop: rounded(element?.scrollTop),
            scrollLeft: rounded(element?.scrollLeft)
        };
    }

    static analyzeImages(container, {minimumImageWidth, minimumImageHeight}) {
        const images = Array.from(container.querySelectorAll('img'));
        const sizeCounts = new Map();
        const imageGeometry = [];
        let renderedImageCount = 0;
        let compactImageCount = 0;
        let avatarLikeImageCount = 0;
        let largeContentImageCount = 0;
        let smallImageCount = 0;
        let largeEnoughImageCount = 0;

        images.forEach((image) => {
            const dimensions = ContainerAnalyser.getImageGeometry(image);
            const {width, height, rendered} = dimensions;
            if (rendered) renderedImageCount += 1;
            if (width <= 0 || height <= 0) return;

            const aspectRatio = width / height;
            const compact = Math.max(width, height) <= 192 && aspectRatio >= .72 && aspectRatio <= 1.4;
            const avatarLike = compact && aspectRatio >= .82 && aspectRatio <= 1.22;
            const relevant = width >= minimumImageWidth && height >= minimumImageHeight;
            const key = `${width}x${height}`;

            sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + 1);
            if (compact) compactImageCount += 1;
            if (avatarLike) avatarLikeImageCount += 1;
            if (relevant) {
                largeEnoughImageCount += 1;
                largeContentImageCount += 1;
            } else {
                smallImageCount += 1;
            }
            if (imageGeometry.length < 32) {
                imageGeometry.push({width, height, aspectRatio: Number(aspectRatio.toFixed(2)), rendered});
            }
        });

        const [dominantImageSize = 'none', dominantImageSizeCount = 0] =
            [...sizeCounts.entries()].sort((first, second) => second[1] - first[1])[0] ?? [];
        const [dominantImageWidth = 0, dominantImageHeight = 0] = dominantImageSize
            .split('x')
            .map(Number);
        const dominantImageSizeRatio = ratio(dominantImageSizeCount, images.length);
        const dominantImageIsSmall = dominantImageWidth > 0 && dominantImageHeight > 0 &&
            (dominantImageWidth < minimumImageWidth || dominantImageHeight < minimumImageHeight);
        const dominantImageIsAvatarSized = dominantImageWidth > 0 && dominantImageHeight > 0 &&
            Math.max(dominantImageWidth, dominantImageHeight) <= 192;

        return {
            imageCount: images.length,
            renderedImageCount,
            compactImageCount,
            avatarLikeImageCount,
            largeContentImageCount,
            smallImageCount,
            largeEnoughImageCount,
            compactImages: compactImageCount > 0 && ratio(compactImageCount, images.length) >= .55,
            avatarPattern: avatarLikeImageCount > 0 && ratio(avatarLikeImageCount, images.length) >= .55,
            largeContentImages: largeContentImageCount > 0,
            eligibleImageRatio: ratio(largeEnoughImageCount, images.length),
            dominantImageSize,
            dominantImageSizeRatio,
            dominantImageIsSmall,
            dominantImageIsAvatarSized,
            distinctImageSizes: sizeCounts.size,
            imageGeometry
        };
    }

    static getImageGeometry(image) {
        let rect = null;
        try {
            rect = image?.getBoundingClientRect?.() ?? null;
        } catch {
            // Attribute and natural dimensions remain useful fallback evidence.
        }

        const renderedWidth = rounded(rect?.width);
        const renderedHeight = rounded(rect?.height);
        const width = renderedWidth || Math.max(
            rounded(image?.getAttribute?.('width')),
            rounded(image?.width),
            rounded(image?.naturalWidth)
        );
        const height = renderedHeight || Math.max(
            rounded(image?.getAttribute?.('height')),
            rounded(image?.height),
            rounded(image?.naturalHeight)
        );

        return {width, height, rendered: renderedWidth > 0 && renderedHeight > 0};
    }

    static isPlausibleStructureContainer(element) {
        if (!ContainerAnalyser.isElement(element)) return false;

        const tagName = element.tagName?.toLowerCase?.() ?? '';
        const role = String(element.getAttribute?.('role') ?? '').trim().toLowerCase();
        if (tagName === 'ul' || tagName === 'ol' || role === 'list' || role === 'listbox') {
            return true;
        }
        if (['li', 'a', 'button', 'option', 'img', 'picture', 'source', 'svg'].includes(tagName)) {
            return false;
        }

        const children = Array.from(element.children ?? []);
        const ownTokens = ContainerAnalyser.getOwnSemanticTokens(element);
        const hasStructureSemantics = [...STRUCTURE_CONTAINER_TERMS].some((term) =>
            ownTokens.has(term)
        );
        if (hasStructureSemantics && children.length >= 2) return true;
        if (children.length < 4) return false;

        const sampledChildren = children.slice(0, DEFAULT_MAX_ROWS);
        const fingerprints = new Map();
        sampledChildren.forEach((child) => {
            const fingerprint = ContainerAnalyser.getRowFingerprint(child);
            fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
        });
        const similarChildren = Math.max(0, ...fingerprints.values());
        return similarChildren / sampledChildren.length >= .7;
    }

    static findRepeatedRowGroup(container, {maxSearchDepth, maxSearchNodes, maxRows}) {
        let examinedNodes = 0;
        const depthLimit = Math.max(0, maxSearchDepth);
        const nodeLimit = Math.max(1, maxSearchNodes);
        const findFirst = (element, depth) => {
            if (!element || examinedNodes >= nodeLimit) return null;

            examinedNodes += 1;
            const rows = Array.from(element.children ?? []);
            if (rows.length >= 4) {
                const sampledRows = rows.slice(0, Math.max(4, maxRows));
                const fingerprints = new Map();
                sampledRows.forEach((row) => {
                    const fingerprint = ContainerAnalyser.getRowFingerprint(row);
                    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
                });

                const similarRowCount = Math.max(0, ...fingerprints.values());
                const rowSimilarity = ratio(similarRowCount, sampledRows.length);
                if (rowSimilarity >= .7) {
                    return {element, rows, depth, rowSimilarity, similarRowCount};
                }
            }

            if (depth >= depthLimit) return null;
            for (const child of rows) {
                const found = findFirst(child, depth + 1);
                if (found) return found;
            }
            return null;
        };

        const firstMatch = findFirst(container, 0) ?? {
            element: container,
            rows: [],
            depth: 0,
            rowSimilarity: 0,
            similarRowCount: 0
        };

        return {
            rows: firstMatch.rows,
            rowCount: firstMatch.rows.length,
            rowSimilarity: firstMatch.rowSimilarity,
            similarRowCount: firstMatch.similarRowCount,
            rowGroupTag: firstMatch.element?.tagName?.toLowerCase?.() ?? 'unknown',
            rowGroupIdentifier: ContainerAnalyser.getElementIdentifier(firstMatch.element),
            rowGroupDepth: firstMatch.depth
        };
    }

    static analyzeRows(rows, {maxRows, minimumImageWidth, minimumImageHeight}) {
        const sampledRows = Array.from(rows ?? []).slice(0, Math.max(0, maxRows));
        let textRowCount = 0;
        let truncatedTextRowCount = 0;
        let badgeRowCount = 0;
        let avatarRowCount = 0;

        sampledRows.forEach((row) => {
            const text = String(row.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (text) textRowCount += 1;
            if (ContainerAnalyser.hasTruncatedText(row)) truncatedTextRowCount += 1;
            if (ContainerAnalyser.hasBadgeOrStatus(row)) badgeRowCount += 1;

            const rowImages = Array.from(row.querySelectorAll('img'));
            const hasAvatar = rowImages.some((image) => {
                const {width, height} = ContainerAnalyser.getImageGeometry(image);
                if (width <= 0 || height <= 0) return false;

                const imageRatio = width / height;
                return Math.max(width, height) <= Math.min(192, Math.max(
                    minimumImageWidth,
                    minimumImageHeight
                )) && imageRatio >= .82 && imageRatio <= 1.22;
            });
            if (hasAvatar) avatarRowCount += 1;
        });

        const rowCount = sampledRows.length;
        const textRowRatio = ratio(textRowCount, rowCount);
        const truncatedTextRowRatio = ratio(truncatedTextRowCount, rowCount);
        const badgeRowRatio = ratio(badgeRowCount, rowCount);
        const avatarRowRatio = ratio(avatarRowCount, rowCount);

        return {
            textRowCount,
            truncatedTextRowCount,
            badgeRowCount,
            avatarRowCount,
            textRowRatio,
            truncatedTextRowRatio,
            badgeRowRatio,
            avatarRowRatio,
            textPattern: rowCount >= 4 && textRowRatio >= .6,
            truncationPattern: rowCount >= 4 && truncatedTextRowRatio >= .25,
            badgePattern: rowCount >= 4 && badgeRowRatio >= .15,
            avatarPattern: rowCount >= 4 && avatarRowRatio >= .55
        };
    }

    static analyzeSemantics(container) {
        const tokens = ContainerAnalyser.getSemanticTokens(container);
        const matches = {
            inbox: [...INBOX_TERMS].filter((term) => tokens.has(term)),
            menu: [...MENU_TERMS].filter((term) => tokens.has(term)),
            content: [...CONTENT_TERMS].filter((term) => tokens.has(term))
        };

        return {
            matches,
            inboxSemantics: matches.inbox.length > 0,
            menuSemantics: matches.menu.length > 0,
            contentSemantics: matches.content.length > 0
        };
    }

    static getSemanticTokens(container) {
        const elements = [container, ...Array.from(container.querySelectorAll('*')).slice(0, 260)];
        const tokens = new Set();

        elements.forEach((element) => {
            ContainerAnalyser.getOwnSemanticTokens(element).forEach((token) => tokens.add(token));
        });

        return tokens;
    }

    static getOwnSemanticTokens(element) {
        const tokens = new Set();
        [
            element?.getAttribute?.('class'),
            element?.getAttribute?.('id'),
            element?.getAttribute?.('role'),
            element?.getAttribute?.('aria-label'),
            element?.getAttribute?.('aria-description'),
            element?.getAttribute?.('data-testid'),
            element?.getAttribute?.('data-test'),
            element?.getAttribute?.('data-type')
        ].forEach((value) => {
            ContainerAnalyser.extractTokens(value).forEach((token) => tokens.add(token));
        });
        Array.from(element?.attributes ?? []).forEach((attribute) => {
            if (attribute.name === 'class' || attribute.name === 'id') return;
            if (attribute.name === 'role' || attribute.name.startsWith('aria-') ||
                attribute.name.startsWith('data-')) {
                ContainerAnalyser.extractTokens(attribute.name).forEach((token) => tokens.add(token));
            }
        });
        return tokens;
    }

    static getClassTokens(element) {
        return ContainerAnalyser.extractTokens(element?.getAttribute?.('class')).slice(0, 8);
    }

    static getStructureAttributeNames(element) {
        return Array.from(element?.attributes ?? [])
            .map((attribute) => attribute.name.toLowerCase())
            .filter((name) => name === 'role' || name.startsWith('aria-') || name.startsWith('data-'))
            .slice(0, 8);
    }

    static getRowFingerprint(row) {
        const childTags = Array.from(row.children ?? [], (child) => child.tagName.toLowerCase())
            .slice(0, 8)
            .join(',');
        const directCounts = ['img', 'svg', 'a', 'button', 'input'].map((tagName) =>
            row.querySelectorAll(tagName).length
        ).join(',');

        return [
            row.tagName.toLowerCase(),
            ContainerAnalyser.getClassTokens(row).join(','),
            row.getAttribute?.('role') ?? '',
            ContainerAnalyser.getStructureAttributeNames(row).join(','),
            childTags,
            directCounts
        ].join('|');
    }

    static hasTruncatedText(row) {
        const elements = [row, ...Array.from(row.querySelectorAll(
            'span,p,a,strong,em,small,div,[role="text"]'
        )).slice(0, 24)];

        return elements.some((element) => {
            const text = String(element.textContent ?? '').trim();
            if (!text) return false;

            try {
                const style = getComputedStyle(element);
                const lineClamp = Number(style.webkitLineClamp || style.lineClamp ||
                    style.getPropertyValue?.('-webkit-line-clamp'));
                return style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap' ||
                    Number.isFinite(lineClamp) && lineClamp > 0;
            } catch {
                return false;
            }
        });
    }

    static hasBadgeOrStatus(row) {
        const elements = [row, ...Array.from(row.querySelectorAll('*')).slice(0, 48)];
        return elements.some((element) => {
            const tokens = new Set([
                ...ContainerAnalyser.extractTokens(element.getAttribute?.('class')),
                ...ContainerAnalyser.extractTokens(element.getAttribute?.('id')),
                ...ContainerAnalyser.extractTokens(element.getAttribute?.('aria-label')),
                ...ContainerAnalyser.extractTokens(element.getAttribute?.('role'))
            ]);
            return [...BADGE_TERMS].some((term) => tokens.has(term));
        });
    }

    static getInboxScore({
        hasRepeatedRows,
        rowSimilarity,
        rowCount,
        avatarPattern,
        textPattern,
        truncationPattern,
        badgePattern,
        inboxSemantics,
        largeContentImages
    }) {
        let score = hasRepeatedRows ? rowSimilarity * 25 + Math.min(12, rowCount / 4) : 0;
        if (avatarPattern) score += 30;
        if (textPattern) score += 10;
        if (truncationPattern) score += 7;
        if (badgePattern) score += 5;
        if (inboxSemantics) score += 16;
        if (largeContentImages) score -= 32;
        return clampScore(score);
    }

    static getMenuScore({
        hasRepeatedRows,
        rowSimilarity,
        hasNavigationLandmark,
        menuSemantics,
        compactImages,
        interactiveCount,
        rowCount,
        largeContentImages
    }) {
        let score = hasRepeatedRows ? rowSimilarity * 24 : 0;
        if (hasNavigationLandmark) score += 24;
        if (menuSemantics) score += 18;
        if (compactImages) score += 8;
        if (interactiveCount >= Math.max(4, rowCount / 2)) score += 16;
        if (largeContentImages) score -= 28;
        return clampScore(score);
    }

    static getContentScore({
        largeContentImages,
        largeEnoughImageCount,
        eligibleImageRatio,
        distinctImageSizes,
        contentSemantics,
        mediaElements,
        videos,
        hasContentLandmark
    }) {
        let score = largeContentImages ? 30 : 0;
        score += Math.min(20, largeEnoughImageCount * 4);
        if (eligibleImageRatio >= .35) score += 12;
        if (distinctImageSizes >= 3) score += 8;
        if (contentSemantics && (mediaElements > 0 || largeEnoughImageCount > 0)) score += 16;
        if (videos > 0 || hasContentLandmark) score += 10;
        return clampScore(score);
    }

    static hasNavigationLandmark(container) {
        const tagName = container.tagName?.toLowerCase?.() ?? '';
        return tagName === 'nav' || tagName === 'aside' || container.querySelector('nav, aside') !== null;
    }

    static hasContentLandmark(container) {
        const tagName = container.tagName?.toLowerCase?.() ?? '';
        return tagName === 'main' || tagName === 'article';
    }

    static getElementIdentifier(element) {
        const tagName = element?.tagName?.toLowerCase?.() ?? 'unknown';
        const id = String(element?.getAttribute?.('id') ?? '').trim();
        if (id) return `${tagName}#${id}`;

        const className = String(element?.getAttribute?.('class') ?? '').trim().split(/\s+/, 1)[0];
        return className ? `${tagName}.${className.slice(0, 48)}` : tagName;
    }

    static extractTokens(value) {
        if (typeof value !== 'string') return [];
        return value
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => /^[a-z][a-z0-9]{1,40}$/.test(token));
    }

    static isElement(value) {
        return Boolean(value && value.nodeType === 1 && typeof value.querySelectorAll === 'function');
    }

    static getEmptyAnalysis() {
        return {
            scrollable: false,
            scrollAxis: 'none',
            verticallyScrollable: false,
            horizontallyScrollable: false,
            geometry: {},
            repeatedRows: false,
            rowCount: 0,
            rowSimilarity: 0,
            similarRowCount: 0,
            compactImages: false,
            avatarPattern: false,
            textPattern: false,
            truncationPattern: false,
            badgePattern: false,
            inboxSemantics: false,
            menuSemantics: false,
            contentSemantics: false,
            largeContentImages: false,
            inboxScore: 0,
            menuScore: 0,
            contentScore: 0,
            classification: 'unknown',
            classificationKind: 'unknown',
            priority: 'medium',
            score: 0,
            suggestedAction: 'normal',
            positiveSignals: [],
            negativeSignals: []
        };
    }
}

export default ContainerAnalyser;
