import { app } from "../../scripts/app.js";

const EXTENSION_NAME = "Comfy.FlowWrangler";
const EXTENSION_VERSION = "0.3.0";
const SETTING_GESTURE = `${EXTENSION_NAME}.LazyConnectGesture`;
const SETTING_REPLACE = `${EXTENSION_NAME}.ReplaceConnectedInputs`;
const BYPASS_MODE = 4;
const ALWAYS_MODE = 0;

let gestureEnabled = true;
let replaceConnectedInputs = false;
let lastPointer = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
let lazyGesture = null;
let pendingClickSource = null;
let suppressContextMenuUntil = 0;
let gestureOverlay = null;

function notify(detail, severity = "info") {
    const toast = app.extensionManager?.toast;
    if (toast?.add) {
        toast.add({ severity, summary: "Flow Wrangler", detail, life: 2600 });
        return;
    }
    console.log(`[Flow Wrangler] ${detail}`);
}

function graphChanged(fn) {
    const graph = app.graph;
    graph?.beforeChange?.();
    try {
        return fn();
    } finally {
        graph?.afterChange?.();
        graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    }
}

function normalizeType(type) {
    if (Array.isArray(type)) return type.map(normalizeType).join(",");
    return String(type ?? "*").trim().toUpperCase();
}

function normalizeName(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function polarityFromText(value) {
    const text = String(value ?? "").toLowerCase();
    if (!text) return "neutral";

    // Keep this deliberately conservative: generic words such as "prompt" are
    // not positive signals because both prompt encoders often keep the same
    // default title.
    if (/(^|[^a-z])(negative|neg|uncond|unconditional|uc)([^a-z]|$)/.test(text)
        || /(\u8d1f\u5411|\u8d1f\u9762|\u8d1f\u63d0\u793a|\u53cd\u5411\u63d0\u793a|\u53cd\u5411\u8bcd|\u660e\u786e\u6392\u9664|\u6392\u9664\u9879)/.test(text)) {
        return "negative";
    }
    if (/(^|[^a-z])(positive|pos)([^a-z]|$)/.test(text)
        || /(\u6b63\u5411|\u6b63\u9762|\u6b63\u63d0\u793a|\u4e3b\u63d0\u793a)/.test(text)) {
        return "positive";
    }
    return "neutral";
}


const SEMANTIC_STOP_WORDS = new Set([
    "node", "loader", "load", "output", "input", "conditioning", "condition", "model",
    "image", "video", "latent", "clip", "vae", "sampler", "ksampler", "prompt", "encode",
    "decode", "apply", "global", "true", "decoy", "boss", "final", "target", "source",
]);
const SEMANTIC_CACHE_LIMIT = 4096;
const semanticWordsCache = new Map();
const semanticRolesCache = new Map();
const semanticTokenCache = new Map();
const branchSignatureCache = new Map();
const titleIdentityCache = new Map();
let titleAffinityPairCache = new WeakMap();
let sourcePolarityCache = new WeakMap();
let activeSelectionContext = null;

function resetCommandSemanticCaches() {
    titleAffinityPairCache = new WeakMap();
    sourcePolarityCache = new WeakMap();
}

function cacheValue(cache, key, create) {
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= SEMANTIC_CACHE_LIMIT) cache.clear();
    const value = create();
    cache.set(key, value);
    return value;
}

function semanticWords(value) {
    const raw = String(value ?? "");
    return cacheValue(semanticWordsCache, raw, () => {
        const text = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
        return text.match(/[a-z]+\d*|\d+|[\u4e00-\u9fff]+/g) ?? [];
    });
}

function branchSignature(value) {
    const raw = String(value ?? "");
    return cacheValue(branchSignatureCache, raw, () => {
        const words = semanticWords(raw).slice(0, 5);
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            if (/^[a-z]{1,8}\d+$/.test(word)) return word;
            if (/^\d+$/.test(word) && i > 0 && /^[a-z]{1,12}$/.test(words[i - 1])) {
                return `${words[i - 1]}${word}`;
            }
        }
        return null;
    });
}

function semanticTokenSet(value) {
    const raw = String(value ?? "");
    return cacheValue(semanticTokenCache, raw, () => new Set(semanticWords(raw).filter((word) => {
        if (!word || SEMANTIC_STOP_WORDS.has(word)) return false;
        if (/^\d+$/.test(word)) return false;
        return word.length >= 3 || /\d/.test(word) || /[\u4e00-\u9fff]/.test(word);
    })));
}

function nodeText(node, slot = null) {
    const parts = [
        node?.title,
        node?.type,
        node?.constructor?.title,
        node?.properties?.["Node name for S&R"],
    ];
    if (slot) parts.push(slot.name, slot.label);
    return parts.filter(Boolean).join(" ");
}

function semanticRoles(value) {
    const raw = String(value ?? "");
    return cacheValue(semanticRolesCache, raw, () => {
    const text = raw.toLowerCase();
    const roles = new Set();
    const add = (name, pattern) => { if (pattern.test(text)) roles.add(name); };

    add("refiner", /\brefiner\b/);
    add("base", /\bbase\b/);
    add("reference", /\b(reference|ref)\b|\u53c2\u8003|\u53c2\u7167/);
    add("raw", /\b(raw|source|original|input)\b|\u539f\u56fe|\u6e90\u56fe/);
    add("result", /\b(result|output|final)\b|\u7ed3\u679c|\u8f93\u51fa|\u6700\u7ec8/);
    add("decoy", /\bdecoy\b|\u8bef\u5bfc|\u5e72\u6270/);
    add("target", /\btarget\b|\u76ee\u6807/);
    add("control", /\b(control|controlnet)\b/);
    add("preprocess", /\b(depth|pose|canny|edge|normal|scribble|preprocess|preprocessor)\b|dwpose|openpose|\u6df1\u5ea6|\u9aa8\u67b6|\u59ff\u6001|\u59ff\u52bf/);
    add("vision", /\b(vision|clipvision)\b/);
    add("inpaint", /\b(inpaint|inpainting)\b|\u91cd\u7ed8|\u4fee\u590d/);
    add("mask", /\bmask\b|\u906e\u7f69/);
    add("upscale", /\b(upscale|upscaler|hires|highres)\b|\u653e\u5927|\u8d85\u5206/);
    add("color", /\b(color|colour|colormatch)\b|\u8272\u5f69/);
    add("composite", /\b(composite|compositor|blend)\b|\u5408\u6210/);
    add("foreground", /\b(foreground|fg)\b|\u524d\u666f/);
    add("background", /\b(background|bg)\b|\u80cc\u666f/);
    add("t2i", /\b(t2i|text.?to.?image)\b/);
    add("i2i", /\b(i2i|img2img|image.?to.?image)\b/);
    add("t2v", /\b(t2v|text.?to.?video)\b/);
    add("i2v", /\b(i2v|image.?to.?video)\b/);
    add("v2v", /\b(v2v|video.?to.?video)\b/);
    add("audio", /\baudio\b/);
    add("motion", /\bmotion\b/);
    add("adapter", /\b(ipadapter|adapter)\b/);
    add("mix", /\b(mix|mixer|mux)\b/);
    add("aggregate", /\b(combine|merge|aggregate|concat)\b/);
    add("animate", /\b(animate|animation)\b/);
    add("frame", /\b(frame|frames)\b/);
    add("prompt", /\b(prompt|positive|negative|pos|neg|uncond)\b|\u63d0\u793a/);
    return roles;
    });
}


function titleIdentity(value) {
    const raw = String(value ?? "");
    return cacheValue(titleIdentityCache, raw, () => {
        const raw = String(value ?? "");
        const upper = raw.toUpperCase();
        const laneMatches = [];
        const laneRe = /\b([A-Z][A-Z0-9]*)[-_]([A-Z]?)(\d+)\b/g;
        let match;
        while ((match = laneRe.exec(upper))) {
            const family = match[2] ? `${match[1]}-${match[2]}` : match[1];
            laneMatches.push({ family, id: Number(match[3]), token: `${family}-${String(Number(match[3]))}` });
        }
        const pack = /\bPACK\s*(\d+)\b/i.exec(raw);
        const decoy = /\bDECOY\s*(\d+)\b/i.exec(raw);
        const target = /\bTARGET[-_ ]?(\d+)\b/i.exec(raw);
        const scene = /\bSCENE[-_ ]?(\d+)\b/i.exec(raw);
        const pair = /\bPAIR[-_ ]?(\d+)\b/i.exec(raw);
        const variant = /\b(?:MODEL|MOTION|VIDEO)\s*(?:MODEL\s*)?([A-C])\b/i.exec(raw);
        const variantNumber = /\b(?:MODEL|MOTION|VIDEO)\s*(?:MODEL\s*)?(\d+)\b/i.exec(raw);
        const frame = /\bFRAMES?\s*([AB])\b/i.exec(raw);
        return {
            lane: laneMatches[0] ?? null,
            pack: pack ? Number(pack[1]) : null,
            decoy: decoy ? Number(decoy[1]) : null,
            target: target ? Number(target[1]) : null,
            scene: scene ? Number(scene[1]) : null,
            pair: pair ? Number(pair[1]) : null,
            variant: variant ? variant[1].toUpperCase() : null,
            variantNumber: variantNumber ? Number(variantNumber[1]) : null,
            frame: frame ? frame[1].toUpperCase() : null,
        };
    });
}

function identityContext(nodes) {
    const all = nodes.map((node) => ({ node, identity: titleIdentity(node?.title) }));
    const packIds = new Set();
    const laneFamilies = new Map();
    const variantSources = new Map();
    const numericVariantCounts = new Map();
    for (const entry of all) {
        if (entry.identity.pack != null) packIds.add(entry.identity.pack);
        if (entry.identity.lane) {
            const key = entry.identity.lane.family;
            if (!laneFamilies.has(key)) laneFamilies.set(key, new Set());
            laneFamilies.get(key).add(entry.identity.lane.id);
        }
        const type = String(entry.node?.outputs?.[0]?.type ?? "").toUpperCase();
        if ((type.includes("MOTION_MODEL") || type.includes("VIDEO_MODEL")) && entry.identity.variant) {
            const key = `${type}:${entry.identity.variant}`;
            variantSources.set(key, entry.node);
        }
        if ((type.includes("MOTION_MODEL") || type.includes("VIDEO_MODEL")) && entry.identity.variantNumber != null
            && !semanticRoles(entry.node?.title).has("decoy")) {
            const key = type;
            if (!numericVariantCounts.has(key)) numericVariantCounts.set(key, new Set());
            numericVariantCounts.get(key).add(entry.identity.variantNumber);
        }
    }
    return { all, packCount: packIds.size, laneFamilies, variantSources, numericVariantCounts };
}

function structuralIdentityScore(source, target, outputIndex, inputIndex) {
    if (!source || !target) return 0;
    const s = titleIdentity(source.title);
    const t = titleIdentity(target.title);
    const input = target.inputs?.[inputIndex];
    const output = source.outputs?.[outputIndex];
    if (!input || !output) return 0;
    let score = 0;

    // Exact lane identity is the strongest generic signal: IMG-L3 -> IMG-L3,
    // FINAL-08 -> FINAL-08, etc. This deliberately outranks distance.
    if (s.lane && t.lane) {
        if (s.lane.family === t.lane.family && s.lane.id === t.lane.id) {
            if (semanticRoles(target.title).has("refiner") && !semanticRoles(source.title).has("refiner")) score -= 900;
            else score += 650;
        } else if (s.lane.family === t.lane.family) score -= 700;
    }

    // Repeating source banks: PACK 1..N feeding Decoy/Target numbers that
    // repeat modulo N. This handles deliberately large same-type oceans while
    // remaining data-driven from the current selection.
    const sourcePack = s.pack;
    const targetNumber = t.decoy ?? t.target;
    if (sourcePack != null && targetNumber != null) {
        const packCount = activeSelectionContext?.packCount ?? 0;
        if (packCount > 1) {
            const wantedPack = ((targetNumber - 1) % packCount) + 1;
            score += sourcePack === wantedPack ? 5200 : -2600;
        } else if (sourcePack === targetNumber) {
            score += 3600;
        }
    } else if (s.lane && targetNumber != null && activeSelectionContext) {
        const laneCount = activeSelectionContext.laneFamilies.get(s.lane.family)?.size ?? 0;
        if (laneCount > 1) {
            const wantedLane = ((targetNumber - 1) % laneCount) + 1;
            score += s.lane.id === wantedLane ? 5200 : -2600;
        }
    }

    // Scene pairs are a structural relation, not a nearest-neighbour relation:
    // SCENE-01/02 -> PAIR-1 A/B, SCENE-03/04 -> PAIR-2 A/B, ...
    if (s.scene != null && t.pair != null && t.frame) {
        const wantedPair = Math.floor((s.scene - 1) / 2) + 1;
        if (t.pair === wantedPair) score += 4200;
        else score -= 1700;
        const wantedFrame = s.scene % 2 === 1 ? "A" : "B";
        score += t.frame === wantedFrame ? 1500 : -900;
    }

    // Numeric source banks (e.g. TRUE Video Model 1..3) repeat by target id.
    // This is useful for multimodal workflows with several model variants and
    // many targets, without relying on canvas distance.
    const typeKey = normalizeType(output.type);
    const inputNameForVariant = normalizeName(input.name ?? input.label);
    if ((typeKey.includes("VIDEO_MODEL") || typeKey.includes("MOTION_MODEL"))
        && s.variantNumber != null && t.target != null && activeSelectionContext) {
        const count = activeSelectionContext.numericVariantCounts.get(typeKey)?.size ?? 0;
        if (count > 1) {
            const wanted = ((t.target - 1) % count) + 1;
            score += s.variantNumber === wanted ? 5200 : -2600;
        }
    }

    // Two global A/B motion variants are commonly used as alternating lanes.
    // Only apply this when the target is explicitly a motion_model socket and
    // the current selection actually contains both A and B variants.
    const inputName = normalizeName(input.name ?? input.label);
    if (inputName === "motionmodel" && s.variant && activeSelectionContext) {
        const hasA = [...activeSelectionContext.variantSources.keys()].some((key) => key.endsWith(":A"));
        const hasB = [...activeSelectionContext.variantSources.keys()].some((key) => key.endsWith(":B"));
        const motionTargetNumber = t.lane?.id ?? t.target;
        if (hasA && hasB && motionTargetNumber != null) {
            const wanted = motionTargetNumber % 2 === 0 ? "B" : "A";
            score += s.variant === wanted ? 2500 : -2500;
        }
    }

    // When a Control Apply node has three same-lane preprocessors and no
    // stronger model-specific clue, keep the fallback deterministic instead of
    // letting tiny Y-distance differences decide. The cycle is intentionally a
    // weak fallback and can be overridden by explicit target/source semantics.
    if (normalizeName(target.title).includes("controlapply") && semanticRoles(nodeText(source, outputIndex)).has("preprocess") && t.lane?.id != null) {
        const preprocessOrder = ["depth", "pose", "canny"];
        const sourceWords = semanticWords(source.title).map((x) => x.toLowerCase());
        const sourceKind = preprocessOrder.find((kind) => sourceWords.includes(kind));
        if (sourceKind) {
            const wanted = preprocessOrder[(t.lane.id - 1) % preprocessOrder.length];
            score += sourceKind === wanted ? 1050 : -500;
        }
    }

    const sourceIsDecoy = semanticRoles(nodeText(source, outputIndex)).has("decoy");
    const targetIsDecoy = semanticRoles(nodeText(target, inputIndex)).has("decoy");
    if (sourceIsDecoy && !targetIsDecoy) score -= 15000;

    // If an unlabeled Image KSampler has both a same-lane Control Apply and an
    // Inpaint Conditioning candidate, prefer the explicit control branch. A
    // target explicitly labeled Inpaint is handled by the stronger role score.
    if (normalizeName(target.title).includes("imageksampler") && !semanticRoles(target.title).has("inpaint")) {
        if (semanticRoles(source.title).has("control")) score += 1800;
        if (semanticRoles(source.title).has("inpaint")) score -= 1800;
    }

    return score;
}

function titleAffinityScore(source, target) {
    if (!source || !target) return 0;
    let byTarget = titleAffinityPairCache.get(source);
    if (!byTarget) {
        byTarget = new WeakMap();
        titleAffinityPairCache.set(source, byTarget);
    }
    if (byTarget.has(target)) return byTarget.get(target);

    const sourceTitle = String(source?.title ?? "");
    const targetTitle = String(target?.title ?? "");
    const sourceBranch = branchSignature(sourceTitle);
    const targetBranch = branchSignature(targetTitle);
    let score = 0;

    if (sourceBranch && targetBranch) {
        score += sourceBranch === targetBranch ? 1650 : -780;
    }

    const sourceTokens = semanticTokenSet(sourceTitle);
    const targetTokens = semanticTokenSet(targetTitle);
    for (const token of sourceTokens) {
        if (!targetTokens.has(token)) continue;
        if (/\d/.test(token)) score += 420;
        else if (token.length >= 7) score += 210;
        else score += 120;
    }
    score = Math.min(score, 2100);
    byTarget.set(target, score);
    return score;
}

function nodeArchetype(node) {
    const text = `${node?.type ?? ""} ${node?.title ?? ""} ${node?.constructor?.title ?? ""}`.toLowerCase();
    const type = String(node?.type ?? "").toLowerCase();
    const inputNames = new Set((node?.inputs ?? []).map((input) => normalizeName(input?.name ?? input?.label)));
    const outputTypes = new Set((node?.outputs ?? []).map((output) => normalizeType(output?.type)));
    if (type.includes("saveimage") || type.includes("previewimage") || type.includes("savevideo")
        || type.includes("videocombine") || type.includes("savegif") || type.includes("savewebp")
        || /\b(save image|preview image|save video)\b/.test(text)) return "sink";
    // LoRA nodes are MODEL/CLIP transformers, not root resource loaders. Treat
    // them like adapters so downstream samplers prefer the transformed model.
    if ((type.includes("lora") || /\blora\b/.test(text))
        && inputNames.has("model") && outputTypes.has("MODEL")) return "adapter";
    // Generic MODEL transformers (for example Krea2ControlApply, model sampling
    // modifiers, custom patch/apply nodes) are part of the causal MODEL chain.
    // Detect by contract rather than by a growing list of third-party names.
    if (inputNames.has("model") && outputTypes.has("MODEL")) return "adapter";
    if (type.includes("checkpointloader") || type === "loadimage"
        || type.includes("clipvisionloader") || type.includes("ipadaptermodelloader")
        || type.includes("upscalemodelloader") || type.includes("vaeloader")
        || type.includes("controlnetloader") || type.includes("modelpatchloader") || type.includes("loader")) return "loader";
    if (type.includes("ksampler") || type.includes("sampler") || type.includes("videodiffusion")
        || /\b(txt2img|text.?to.?image)\b/.test(text)) return "sampler";
    if (type.includes("vaedecode") || type.includes("wanvideodecode") || type.includes("latentdecode")
        || /\bdecode\b/.test(text)) return "decode";
    if (type.includes("vaeencode") || type.includes("wanvideoencode") || type.includes("latentencode")
        || (type.includes("encode") && !type.includes("textencode")) || /\bencode\b/.test(text)) return "encode";
    if (type.includes("upscale") || /\b(upscale|upscaler|hires|superres)\b/.test(text)) return "upscale";
    // Model-transform adapters (including Anima LLLite) consume MODEL + patch/image
    // and produce a transformed MODEL. Classify them before generic animation text
    // matching so chained model transforms preserve their causal order.
    if (type.includes("ipadapter") || type.includes("llliteapply") || /\b(adapter)\b/.test(text)
        || (inputNames.has("model") && inputNames.has("modelpatch") && outputTypes.has("MODEL"))) return "adapter";
    if (type.includes("controlnetapply") || type.includes("applycontrolnet") || /\bcontrol.?apply\b/.test(text)) return "control";
    if (type.includes("openpose") || type.includes("preprocessor") || type.includes("preprocess")
        || (rawControlFamilyFromText(type) && inputNames.has("image") && outputTypes.has("IMAGE")
            && !type.includes("encode") && !type.includes("apply"))) return "preprocess";
    if (type.includes("composite") || type.includes("blend") || type.includes("merge") || type.includes("combine")
        || type.includes("colormatch") || /\b(composite|blend|merge|combine|concat|color\s*match)\b/.test(text)) return "composite";
    if (type.includes("clipsetlastlayer") || type.includes("cliptextencode") || type.includes("textencode")
        || type.includes("conditioningcombine") || /\bconditioning\b/.test(type)) return "conditioning";
    if (type === "setnode" || type === "getnode") return "routing";
    if (type.includes("animation") || type.includes("anima") || /\b(anima|animate|video output|final video)\b/.test(text)) return "animation";
    return "transform";
}

function slotSemantic(value) {
    const text = String(value ?? "").toLowerCase();
    if (/\b(samples?|latent|latent_image)\b/.test(text)) return "latent";
    if (/\b(images?|image_negative|pixels?|control_image)\b/.test(text)) return "image";
    if (/\b(mask|masks)\b/.test(text)) return "mask";
    if (/\b(model|model_to_offload|video_model|motion_model)\b/.test(text)) return "model";
    if (/\b(clip|t5|text_encoder|wan_t5_model)\b/.test(text)) return "text_model";
    if (/\b(vae)\b/.test(text)) return "vae";
    if (/\b(conditioning|positive|negative|uncond|prompt|text_embeds)\b/.test(text)) return "conditioning";
    if (/\b(control_net|controlnet)\b/.test(text)) return "control";
    if (/\b(ipadapter|clip_vision|vision)\b/.test(text)) return "vision";
    if (/\b(upscale_model|upscaler)\b/.test(text)) return "upscale_model";
    if (/\b(audio|sound)\b/.test(text)) return "audio";
    return "generic";
}

function producerRoleScore(source, outputIndex, target, inputIndex) {
    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    if (!output || !input) return 0;

    const sourceKind = nodeArchetype(source);
    const targetKind = nodeArchetype(target);
    const inputName = String(input.name ?? input.label ?? "").toLowerCase();
    const outputName = String(output.name ?? output.label ?? "").toLowerCase();
    const inputRole = slotSemantic(inputName);
    const outputRole = slotSemantic(outputName || output.type);
    let score = 0;

    // Display/save nodes are terminal consumers. Their pass-through IMAGE output
    // is technically type-compatible, but using it as a producer usually creates
    // a bogus Preview -> Preview / Save -> Save chain.
    if (sourceKind === "sink") score -= 3600;

    // Latent decode has a very specific causal direction: sampler/latent-producing
    // nodes feed `samples`; an EmptyLatentImage is an initializer and should not
    // jump directly into VAEDecode when a sampler result exists.
    if (targetKind === "decode" && inputRole === "latent") {
        if (sourceKind === "sampler" || sourceKind === "encode" || /latent.*output|sample/i.test(outputName)) score += 3000;
        if (/emptylatent/i.test(String(source.type)) || /empty.*latent/i.test(String(source.title))) score -= 2300;
    }

    // Generated-image consumers should prefer the current image-producing stage,
    // not an unrelated raw reference / pose / control image.
    if ((targetKind === "upscale" || targetKind === "sink") && inputRole === "image") {
        if (sourceKind === "decode" || sourceKind === "upscale" || sourceKind === "composite" || sourceKind === "sampler") score += 2200;
        if (sourceKind === "preprocess") score -= 1800;
        if (sourceKind === "loader" && !semanticRoles(source.title).has("reference") && !semanticRoles(source.title).has("raw")) score -= 500;
    }

    // Final image/video outputs must not accidentally consume an early-stage
    // generated/reference/control image. In large multimodal graphs IMAGE is a
    // very overloaded type; enforce the causal stage boundary.
    if (targetKind === "sink" && inputRole === "image") {
        if (sourceKind === "animation") score += 4200;
        if (sourceKind === "preprocess" || sourceKind === "loader") score -= 3200;
        if (semanticRoles(nodeText(source, output)).has("control")) score -= 4000;
    }

    // ControlNet image inputs want the control/preprocessed branch. A raw image
    // is only a fallback when no preprocessing candidate exists.
    if (targetKind === "control" && inputRole === "image") {
        if (sourceKind === "preprocess" || semanticRoles(nodeText(source, output)).has("preprocess")) score += 2400;
        if (sourceKind === "loader" || semanticRoles(nodeText(source, output)).has("raw")) score -= 550;
        if (sourceKind === "decode" || sourceKind === "upscale") score -= 900;
        // Preview/save/decoded images from an earlier generation stage are not
        // valid substitutes for a pose/depth/canny conditioning image.
        if (sourceKind === "sampler" || sourceKind === "decode" || sourceKind === "sink") score -= 5000;
    }

    // IPAdapter's image input is normally a reference/CLIP-vision-prepared image,
    // while pose/depth preprocessors belong to ControlNet branches.
    if (targetKind === "adapter" && inputRole === "image") {
        if (sourceKind === "preprocess" && /clipvision|prepimageforclipvision/i.test(`${source.type} ${source.title}`)) score += 2400;
        if (sourceKind === "loader" && semanticRoles(source.title).has("reference")) score += 1300;
        if (sourceKind === "preprocess" && !/clipvision|prepimageforclipvision/i.test(`${source.type} ${source.title}`)) score -= 1200;
    }

    // Text/model/conditioning pipelines are stage-like: prefer transformed
    // resources over an earlier root when both are otherwise type-compatible.
    if (inputRole === "model") {
        const targetType = String(target.type ?? "").toLowerCase();
        const isModelLoader = targetType.includes("checkpointloader")
            || targetType.includes("modelloader") || targetKind === "loader";
        if (isModelLoader) {
            if (sourceKind === "adapter") score -= 2200;
            if (sourceKind === "loader") score += /checkpoint|model.*loader/i.test(String(source.type)) ? 900 : 250;
        } else {
            if (sourceKind === "adapter") score += 1800;
            if (sourceKind === "loader" && /checkpoint/i.test(String(source.type))) score += 500;
            if (targetKind === "sampler" && sourceKind === "adapter") score += 500;
        }
    }
    if (inputRole === "text_model") {
        if (/clipsetlastlayer|lora/i.test(String(source.type))) score += 1400;
        if (/checkpoint/i.test(String(source.type))) score += 350;
    }

    // Explicit slot-name agreement remains useful, but only as a secondary cue.
    if (inputRole !== "generic" && outputRole === inputRole) score += 180;
    return score;
}

function inputRoleScore(source, outputIndex, target, inputIndex) {
    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    if (!output || !input) return 0;

    const sourceText = nodeText(source, output);
    const targetText = nodeText(target, input);
    const sourceRoles = semanticRoles(sourceText);
    const targetRoles = semanticRoles(targetText);
    const inputName = normalizeName(input.name ?? input.label);
    const outputType = normalizeType(output.type);
    let score = 0;

    const hasS = (role) => sourceRoles.has(role);
    const hasT = (role) => targetRoles.has(role);

    if (inputName.includes("reference") || inputName === "ref") {
        if (hasS("reference")) score += 1450;
        if (hasS("raw")) score += 520;
        if (hasS("upscale") || hasS("result") || hasS("target")) score -= 520;
    }
    if (inputName.includes("target")) {
        if (hasS("target") || hasS("result") || hasS("upscale")) score += 780;
        if (hasS("reference") || hasS("raw")) score -= 420;
    }
    if (inputName.includes("foreground")) {
        if (hasS("foreground") || hasS("reference") || hasS("raw")) score += 720;
    }
    if (inputName.includes("background")) {
        if (hasS("background") || hasS("result") || hasS("color") || hasS("upscale")) score += 720;
    }

    if (outputType.includes("IMAGE")) {
        if (hasT("control") && inputName.includes("image")) {
            if (hasS("preprocess") || hasS("control")) score += 920;
            if (hasS("raw") && !hasS("preprocess")) score -= 180;
        }
        if (hasT("vision") && inputName.includes("image")) {
            if (hasS("raw") || hasS("reference")) score += hasT("animate") ? 120 : 300;
            if (hasS("result") || hasS("upscale") || hasS("composite") || hasS("color")) score += 760;
            if (hasS("preprocess")) score -= 620;
        }
        if ((inputName.includes("pixels") || hasT("inpaint")) && !hasT("control")) {
            if (hasS("raw") || hasS("reference")) score += 700;
            if (hasS("preprocess")) score -= 620;
        }
        if (hasT("mask") && inputName.includes("image")) {
            if (hasS("raw") || hasS("reference")) score += 520;
            if (hasS("preprocess")) score -= 300;
        }
    }

    if (inputName.includes("model")) {
        if (hasT("refiner")) {
            if (hasS("refiner")) score += 1900;
            else score -= 620;
        } else {
            if (hasS("adapter")) score += 820;
            if (hasS("refiner")) score -= 500;
        }
    }
    if (inputName === "clip" || inputName.endsWith("clip")) {
        if (hasT("refiner")) {
            if (hasS("refiner")) score += 1700;
            else score -= 560;
        } else if (hasS("refiner")) {
            score -= 1500;
        }
    }

    if (outputType.includes("CONDITIONING")) {
        if (hasT("refiner")) {
            if (hasS("refiner")) score += 1350;
            if (hasS("control") || hasS("inpaint")) score -= 620;
        }
        if (hasT("base") && !hasT("refiner")) {
            if (hasS("control")) score += 760;
            if (hasS("inpaint")) score -= 360;
        }
        if (hasT("inpaint")) {
            if (hasS("control")) score += 900;
            if (hasS("inpaint")) score -= 220;
        }
        if (hasT("t2v") || hasT("i2v") || hasT("v2v")) {
            if (hasS("prompt")) score += 720;
            if (hasS("control") || hasS("inpaint")) score -= 680;
        }
        if (hasT("aggregate")) {
            if (hasS("aggregate")) score += 1750;
        }
    }

    if (outputType.includes("AUDIO") && inputName.includes("audio")) {
        if (hasS("mix")) score += 760;
        if (hasS("raw")) score -= 120;
    }

    if (outputType.includes("LATENT") && hasT("refiner") && inputName.includes("latent")) {
        if (hasS("upscale")) score += 1050;
    }

    return score;
}



function hasControlBranchConsumption(source) {
    // An IMAGE is often both a final render and a ControlNet reference.
    // If an image output is already used by preprocess/control/reference
    // nodes, it should not win as a terminal SaveImage source over later
    // animation/refinement outputs.
    const graphNodes = app.graph?._nodes ?? [];
    const visited = new Set();
    const queue = [source];
    while (queue.length) {
        const node = queue.shift();
        if (!node || visited.has(node)) continue;
        visited.add(node);
        const text = nodeText(node);
        const roles = semanticRoles(text);
        const kind = nodeArchetype(node);
        if (node !== source && (kind === "preprocess" || kind === "control"
            || (kind !== "sink" && (roles.has("preprocess") || roles.has("control") || roles.has("reference"))))) {
            return true;
        }
        for (const out of node.outputs ?? []) {
            for (const linkId of out.links ?? []) {
                const link = app.graph?.links?.[linkId];
                const targetId = link?.target_id ?? link?.to_node;
                const next = graphNodes.find((n) => n.id === targetId);
                if (next) queue.push(next);
            }
        }
    }
    return false;
}

function finalImageStageScore(source, target, inputIndex) {
    // IMAGE is intentionally broad in ComfyUI. For terminal consumers (Save/Preview)
    // prefer final generation stages over intermediate t2i/i2i/control/reference images.
    // This is a weak stage prior and never replaces explicit structural matches.
    const targetKind = nodeArchetype(target);
    const input = target?.inputs?.[inputIndex];
    if (targetKind !== "sink" || !input || slotSemantic(input.name ?? input.label) !== "image") {
        return 0;
    }

    const text = nodeText(source);
    const roles = semanticRoles(text);
    const kind = nodeArchetype(source);
    const intent = sinkImageIntent(target);
    const sourceFamily = controlFamily(source);
    let score = 0;

    if (intent.kind === "control") {
        if (kind === "preprocess" && sourceFamily === intent.family) score += 5200;
        else if (kind === "preprocess") score -= 4200;
        return score;
    }

    if (intent.kind === "final") {
        const stage = localDataStage(source, 0);
        if (stage === DataStage.DECODED || stage === DataStage.UPSCALED || stage === DataStage.GENERATED) score += 1800;
        if (stage === DataStage.CONTROL_SIGNAL || kind === "preprocess") score -= 7200;
        if (stage === DataStage.RAW_INPUT) score -= 1800;
    }

    if (roles.has("animate") || roles.has("t2v") || roles.has("i2v") || roles.has("v2v")
        || /anima|animated|video|wan|motion/i.test(text)) {
        score += 2600;
    }

    if (roles.has("control") || roles.has("preprocess") || roles.has("reference")
        || roles.has("raw")) {
        score -= 2400;
    }

    // Stronger guard for real workflows: intermediate Krea/preview images often
    // have no useful title semantics. If their image lineage enters a ControlNet
    // extraction branch, they are not terminal outputs.
    if (hasControlBranchConsumption(source)) {
        score -= 6000;
    }

    // A sampler directly named as a first generation stage should lose to a
    // later animation/refinement/composite stage when both can feed IMAGE.
    if (kind === "sampler" && !roles.has("animate") && !roles.has("video")) {
        score -= 700;
    }

    if (kind === "decode" || kind === "composite" || kind === "upscale") {
        score += 500;
    }

    return score;
}

function rootResourceScore(source, target, outputIndex) {
    const output = source?.outputs?.[outputIndex];
    if (!output || (source?.inputs?.length ?? 0) !== 0) return 0;
    const type = normalizeType(output.type);
    const rootTypes = [
        "MODEL", "CLIP", "VAE", "VIDEO_MODEL", "MOTION_MODEL", "CONTROL_NET",
        "CLIP_VISION", "IPADAPTER", "UPSCALE_MODEL", "AUDIO",
    ];
    if (!rootTypes.some((rootType) => type === rootType || type.includes(rootType))) return 0;
    const dx = (target?.pos?.[0] ?? 0) - (source?.pos?.[0] ?? 0);
    if (dx <= 0) return -320;
    return Math.min(dx, 5200) * 0.14;
}

function sourcePolarity(node, outputIndex) {
    if (!node) return "neutral";
    let byOutput = sourcePolarityCache.get(node);
    if (!byOutput) {
        byOutput = new Map();
        sourcePolarityCache.set(node, byOutput);
    }
    if (byOutput.has(outputIndex)) return byOutput.get(outputIndex);
    const output = node?.outputs?.[outputIndex];
    const parts = [
        node?.title,
        node?.type,
        node?.constructor?.title,
        node?.properties?.["Node name for S&R"],
        output?.name,
        output?.label,
    ];
    let result = "neutral";
    for (const part of parts) {
        const polarity = polarityFromText(part);
        if (polarity !== "neutral") { result = polarity; break; }
    }
    byOutput.set(outputIndex, result);
    return result;
}

function inputPolarity(target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    // Socket names are the strongest signal: KSampler exposes explicit
    // positive/negative CONDITIONING inputs. Fall back to the target title for
    // custom nodes whose socket names are generic.
    for (const part of [input?.name, input?.label]) {
        const polarity = polarityFromText(part);
        if (polarity !== "neutral") return polarity;
    }
    for (const part of [target?.title, target?.type]) {
        const polarity = polarityFromText(part);
        if (polarity !== "neutral") return polarity;
    }
    return "neutral";
}

function conditioningPolarityScore(source, outputIndex, target, inputIndex) {
    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    if (!output || !input) return 0;

    const outputType = normalizeType(output.type);
    const inputType = normalizeType(input.type);
    if (!outputType.includes("CONDITIONING") || !inputType.includes("CONDITIONING")) return 0;

    const wanted = inputPolarity(target, inputIndex);
    if (wanted === "neutral") return 0;
    const offered = sourcePolarity(source, outputIndex);

    if (offered === wanted) return wanted === "negative" ? 1800 : 1400;
    if (offered !== "neutral") return -2200;
    return 0;
}

function typesCompatible(outputType, inputType) {
    const out = normalizeType(outputType);
    const input = normalizeType(inputType);
    if (out === "*" || input === "*" || out === input) return true;
    if (typeof LiteGraph.isValidConnection === "function") {
        try {
            return LiteGraph.isValidConnection(outputType, inputType);
        } catch (_) {
            // Fall back to the union-type check below.
        }
    }
    const outParts = out.split(",").map((part) => part.trim());
    const inputParts = input.split(",").map((part) => part.trim());
    return outParts.some((part) => inputParts.includes(part));
}

function selectedNodes() {
    const canvas = app.canvas;
    const collections = [
        canvas?.selected_nodes,
        canvas?.selectedNodes,
        canvas?.selected_items,
        canvas?.selectedItems,
    ];
    const result = [];
    const seen = new Set();
    for (const collection of collections) {
        if (!collection) continue;
        let values;
        if (collection instanceof Map || collection instanceof Set) values = [...collection.values()];
        else if (Array.isArray(collection)) values = collection;
        else values = Object.values(collection);
        for (const item of values) {
            const node = item?.node ?? item;
            if (!node || seen.has(node) || node.isGroup || (!node.inputs && !node.outputs)) continue;
            seen.add(node);
            result.push(node);
        }
        if (result.length) break;
    }
    return result;
}

function focusedNodes(minimum = 1) {
    const selected = selectedNodes();
    if (selected.length >= minimum) return selected;
    const current = app.canvas?.current_node;
    return current && !current.isGroup ? [current] : selected;
}

function pairScore(source, outputIndex, target, inputIndex, allowReplace = false) {
    const output = source.outputs?.[outputIndex];
    const input = target.inputs?.[inputIndex];
    if (!output || !input || !typesCompatible(output.type, input.type)) return -Infinity;
    if (input.link != null && !allowReplace) return -Infinity;

    const outputType = normalizeType(output.type);
    const inputType = normalizeType(input.type);
    const outputName = normalizeName(output.name ?? output.label);
    const inputName = normalizeName(input.name ?? input.label);
    let score = outputType === inputType ? 120 : 65;
    if (outputType === "*" || inputType === "*") score -= 35;
    if (input.link == null) score += 30;
    else score -= 20;
    if (outputName && inputName) {
        if (outputName === inputName) score += 42;
        else if (outputName.includes(inputName) || inputName.includes(outputName)) score += 18;
    }
    score -= Math.abs(outputIndex - inputIndex) * 0.35;
    return score;
}

function bestPair(source, target, allowReplace = replaceConnectedInputs) {
    let best = null;
    for (let outputIndex = 0; outputIndex < (source.outputs?.length ?? 0); outputIndex++) {
        for (let inputIndex = 0; inputIndex < (target.inputs?.length ?? 0); inputIndex++) {
            const gate = _reasonerCache
                ? validateHardConstraints(source, outputIndex, target, inputIndex, _reasonerCache)
                : { allowed: true };
            if (!gate.allowed) continue;
            const score = pairScore(source, outputIndex, target, inputIndex, allowReplace);
            if (!best || score > best.score) best = { source, target, outputIndex, inputIndex, score };
        }
    }
    return best?.score > -Infinity ? best : null;
}

function connectPair(pair) {
    if (!pair) return false;
    if (pair.target.inputs[pair.inputIndex]?.link != null) {
        pair.target.disconnectInput?.(pair.inputIndex);
    }
    const result = pair.source.connect(pair.outputIndex, pair.target, pair.inputIndex);
    return result !== false && result != null;
}

function smartConnectBetween(first, second, explicitDirection = false) {
    if (!first || !second || first === second) return false;
    getReasonerContext(app.graph?._nodes ?? [first, second]);
    let pair = bestPair(first, second);
    if (!explicitDirection) {
        const reverse = bestPair(second, first);
        if (!pair || (reverse && reverse.score > pair.score + 8)) pair = reverse;
    }
    if (!pair) {
        clearReasonerCache();
        return false;
    }
    const result = connectPair(pair);
    clearReasonerCache();
    return result;
}

function slotPosition(node, isInput, slotIndex) {
    const fallback = [
        node.pos?.[0] + (isInput ? 0 : (node.size?.[0] ?? 180)),
        node.pos?.[1] + 34 + slotIndex * 20,
    ];
    if (typeof node.getConnectionPos !== "function") return fallback;
    try {
        const result = node.getConnectionPos(isInput, slotIndex, [0, 0]);
        return Array.isArray(result) || ArrayBuffer.isView(result) ? [result[0], result[1]] : fallback;
    } catch (_) {
        return fallback;
    }
}


// ═══════════════════════════════════════════════════════════════════
// Graph Reasoner Layer — conservative hard gate + data identity
// ═══════════════════════════════════════════════════════════════════

const DataStage = Object.freeze({
    RAW_INPUT: "RAW_INPUT",
    GENERATED: "GENERATED",
    CONTROL_SIGNAL: "CONTROL_SIGNAL",
    CONTROL_APPLIED: "CONTROL_APPLIED",
    DECODED: "DECODED",
    UPSCALED: "UPSCALED",
    FINAL_OUTPUT: "FINAL_OUTPUT",
    CONDITIONING: "CONDITIONING",
    LATENT: "LATENT",
    MODEL: "MODEL",
    UNKNOWN: "UNKNOWN",
});

let _reasonerCache = null;

function reasonerText(node, includeWidgets = false) {
    const shortWidgets = includeWidgets
        ? (node?.widgets_values ?? [])
            .filter((value) => typeof value === "string" && value.length > 0 && value.length <= 96)
            .join(" ")
        : "";
    return `${nodeText(node)} ${shortWidgets}`.trim();
}

function rawControlFamilyFromText(text) {
    const value = String(text ?? "").toLowerCase();
    if (/dwpose|openpose|(?:^|[^a-z])pose(?:[^a-z]|$)|skeleton|\u9aa8\u67b6|\u59ff\u6001|\u59ff\u52bf/.test(value)) return "pose";
    if (/depth|midas|zoe|\u6df1\u5ea6/.test(value)) return "depth";
    if (/canny|(?:^|[^a-z])edge(?:[^a-z]|$)|\u8fb9\u7f18|\u908a\u7de3/.test(value)) return "canny";
    if (/lineart|line[\s_-]*art|\u7ebf\u7a3f|\u7dda\u7a3f/.test(value)) return "lineart";
    if (/(?:^|[^a-z])normal(?:[^a-z]|$)|\u6cd5\u7ebf|\u6cd5\u7dda/.test(value)) return "normal";
    if (/scribble|\u6d82\u9e26|\u5857\u9d09/.test(value)) return "scribble";
    if (/segment|segmentation|(?:^|[^a-z])seg(?:[^a-z]|$)|\u5206\u5272/.test(value)) return "segment";
    return null;
}

function explicitSinkControlFamily(node) {
    if (nodeArchetype(node) !== "sink") return null;
    const text = reasonerText(node, false).toLowerCase();
    // A sink mentioning "Pose" may simply mean "Anima Pose + LoRA final".
    // Treat it as a control-map sink only when the title explicitly describes a
    // control/map/guide/preprocessor artifact. This prevents semantic leakage
    // from model configuration words into the IMAGE data contract.
    const hasControlArtifactMarker = /control\s*(?:image|map|guide)|(?:pose|depth|canny|lineart|normal|scribble|segment)\s*(?:image|map|guide)|\u63a7\u5236\u56fe|\u63a7\u5236\u5716|\u9aa8\u67b6\u56fe|\u9aa8\u67b6\u5716|\u6df1\u5ea6\u56fe|\u6df1\u5ea6\u5716|\u8fb9\u7f18\u56fe|\u908a\u7de3\u5716/.test(text);
    if (!hasControlArtifactMarker) return null;
    return rawControlFamilyFromText(text);
}

function sinkImageIntent(node) {
    if (nodeArchetype(node) !== "sink") return { kind: "none", family: null };
    const family = explicitSinkControlFamily(node);
    if (family) return { kind: "control", family };

    const type = String(node?.type ?? "").toLowerCase();
    const text = reasonerText(node, false).toLowerCase();
    const roles = semanticRoles(text);
    if (type.includes("saveimage") || type.includes("savevideo") || type.includes("savegif") || type.includes("savewebp")
        || roles.has("result") || /\b(final|result|output)\b|\u6700\u7ec8|\u7ed3\u679c|\u8f93\u51fa/.test(text)) {
        return { kind: "final", family: null };
    }
    return { kind: "generic", family: null };
}

function controlFamily(node) {
    // Widget values are useful for generic preprocessor wrappers such as
    // AIO_Preprocessor (DWPreprocessor / DepthAnythingV2Preprocessor), but they
    // are dangerous on ordinary nodes: a SaveImage filename like "PoseDepth/final"
    // describes a folder, not the semantic type of its IMAGE input.
    const kind = nodeArchetype(node);
    if (kind === "sink") return explicitSinkControlFamily(node);
    const includeWidgets = kind === "preprocess";
    return rawControlFamilyFromText(reasonerText(node, includeWidgets));
}

function localDataStage(node, outputIndex) {
    const outputType = normalizeType(node?.outputs?.[outputIndex]?.type);
    const kind = nodeArchetype(node);
    if (outputType.includes("MODEL") || outputType.includes("CLIP") || outputType.includes("VAE")
        || outputType.includes("CONTROL_NET") || outputType.includes("MODEL_PATCH")) return DataStage.MODEL;
    if (outputType.includes("CONDITIONING")) return DataStage.CONDITIONING;
    if (outputType.includes("LATENT")) return DataStage.LATENT;
    if (!outputType.includes("IMAGE") && !outputType.includes("VIDEO")) return DataStage.UNKNOWN;

    if (kind === "preprocess") return DataStage.CONTROL_SIGNAL;
    if (kind === "loader") return DataStage.RAW_INPUT;
    if (kind === "decode") return DataStage.DECODED;
    if (kind === "upscale" || kind === "composite") return DataStage.UPSCALED;
    if (kind === "sink") return DataStage.FINAL_OUTPUT;
    if (kind === "sampler" || kind === "animation") return DataStage.GENERATED;
    return DataStage.UNKNOWN;
}

function buildReasonerContext(nodes) {
    const outputs = [];
    for (const node of nodes ?? []) {
        for (let outputIndex = 0; outputIndex < (node?.outputs?.length ?? 0); outputIndex++) {
            outputs.push({
                node,
                outputIndex,
                type: node.outputs[outputIndex]?.type,
                stage: localDataStage(node, outputIndex),
                family: controlFamily(node),
                kind: nodeArchetype(node),
            });
        }
    }
    return { nodes: nodes ?? [], outputs };
}

function getReasonerContext(nodes) {
    const list = nodes ?? [];
    if (_reasonerCache && _reasonerCache.nodesRef === list && _reasonerCache.nodeCount === list.length) {
        return _reasonerCache;
    }
    _reasonerCache = { ...buildReasonerContext(list), nodesRef: list, nodeCount: list.length };
    return _reasonerCache;
}

function clearReasonerCache() {
    _reasonerCache = null;
}

function hasMatchingControlProducer(ctx, target, inputIndex, family) {
    const input = target?.inputs?.[inputIndex];
    if (!ctx || !input || !family) return false;
    return ctx.outputs.some((entry) =>
        entry.node !== target
        && entry.kind === "preprocess"
        && entry.family === family
        && typesCompatible(entry.type, input.type)
    );
}

function hasNonControlImageProducer(ctx, target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    if (!ctx || !input) return false;
    return ctx.outputs.some((entry) =>
        entry.node !== target
        && entry.stage !== DataStage.CONTROL_SIGNAL
        && entry.kind !== "sink"
        && typesCompatible(entry.type, input.type)
        && normalizeType(entry.type).includes("IMAGE")
    );
}

function hasFinalImageProducer(ctx, target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    if (!ctx || !input) return false;
    return ctx.outputs.some((entry) =>
        entry.node !== target
        && entry.kind !== "sink"
        && typesCompatible(entry.type, input.type)
        && normalizeType(entry.type).includes("IMAGE")
        && (entry.stage === DataStage.DECODED
            || entry.stage === DataStage.UPSCALED
            || entry.stage === DataStage.GENERATED
            || semanticRoles(reasonerText(entry.node)).has("result"))
    );
}


function hasExplicitFamilyReferenceProducer(ctx, target, inputIndex, family) {
    const input = target?.inputs?.[inputIndex];
    if (!ctx || !input || !family) return false;
    return ctx.outputs.some((entry) => {
        if (entry.node === target || entry.kind === "preprocess" || entry.kind === "sink") return false;
        if (!typesCompatible(entry.type, input.type) || !normalizeType(entry.type).includes("IMAGE")) return false;
        if (controlFamily(entry.node) !== family) return false;
        const roles = semanticRoles(reasonerText(entry.node));
        return roles.has("reference") || roles.has("raw");
    });
}

function hasOrdinaryImageProducer(ctx, target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    if (!ctx || !input) return false;
    return ctx.outputs.some((entry) => {
        if (entry.node === target || entry.kind === "preprocess" || entry.kind === "sink") return false;
        if (!typesCompatible(entry.type, input.type) || !normalizeType(entry.type).includes("IMAGE")) return false;
        return controlFamily(entry.node) == null;
    });
}

function hasSamplerLatentProducer(ctx, target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    if (!ctx || !input) return false;
    return ctx.outputs.some((entry) => entry.node !== target
        && typesCompatible(entry.type, input.type)
        && normalizeType(entry.type).includes("LATENT")
        && (entry.kind === "sampler" || entry.kind === "animation"));
}

function modelTransformPhase(node) {
    if (nodeArchetype(node) !== "adapter") return 0;
    const type = String(node?.type ?? "").toLowerCase();
    const text = reasonerText(node, false).toLowerCase();
    if (type.includes("apply") || type.includes("llliteapply") || type.includes("ipadapterapply")
        || /\bapply\b|\u5e94\u7528/.test(text)) return 30;
    if (type.includes("lora") || type.includes("loader") || /\blora\b/.test(text)) return 10;
    return 20;
}

/**
 * Conservative hard gate.
 *
 * Only reject a semantic class when the selection contains a clearly better
 * producer for that same role. Ambiguous but legal workflows remain available
 * to the existing soft scorer.
 */
function validateHardConstraints(source, outputIndex, target, inputIndex, ctx = _reasonerCache) {
    if (!source || !target || source === target) return { allowed: false, reason: "self" };

    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    if (!output || !input || !typesCompatible(output.type, input.type)) {
        return { allowed: false, reason: "type" };
    }

    const sourceKind = nodeArchetype(source);
    const targetKind = nodeArchetype(target);
    const inputRole = slotSemantic(input.name ?? input.label);
    const sourceStage = localDataStage(source, outputIndex);

    // Optional MASK sockets are frequently technical overrides (LLLite masks,
    // regional masks, etc.). Filling them merely because a LoadImage exposes a
    // MASK output silently changes workflow semantics. Auto-wire an optional
    // mask only when the target explicitly declares mask/inpaint intent.
    if (inputRole === "mask" && input?.shape === 7) {
        const targetRoles = semanticRoles(reasonerText(target));
        if (!targetRoles.has("mask") && !targetRoles.has("inpaint")) {
            return { allowed: false, reason: "optional-mask-without-intent" };
        }
    }

    // A decode node at the end of a selected generation pipeline should consume
    // the sampler/animation latent, not an earlier VAEEncode/empty-latent source.
    if (inputRole === "latent" && targetKind === "decode" && hasSamplerLatentProducer(ctx, target, inputIndex)) {
        if (sourceKind !== "sampler" && sourceKind !== "animation") {
            return { allowed: false, reason: "decode-prefers-generated-latent" };
        }
    }

    // A model-transform node must not be fed by a later transform from the same
    // left-to-right chain. This is a structural impossibility for the automatic
    // reconstruction pass and prevents A <- B / B <- A swaps in LLLite/IPAdapter
    // style chains.
    if (inputRole === "model" && targetKind === "adapter" && sourceKind === "adapter") {
        if (!explicitBranchCompatible(source, target)) {
            return { allowed: false, reason: "cross-branch-model-transform" };
        }
        const sx = source?.pos?.[0] ?? 0;
        const sy = source?.pos?.[1] ?? 0;
        const tx = target?.pos?.[0] ?? 0;
        const ty = target?.pos?.[1] ?? 0;
        const sourceIsLater = sx > tx + 12 || (Math.abs(sx - tx) <= 12 && sy > ty + 12);
        const sourcePhase = modelTransformPhase(source);
        const targetPhase = modelTransformPhase(target);
        // A lower-phase loader/LoRA may legitimately be placed to the right of
        // a later Apply node. Only use geometry as a hard direction constraint
        // when phase information cannot establish the causal order.
        if (sourcePhase > targetPhase && targetPhase > 0) {
            return { allowed: false, reason: "reverse-model-transform-phase" };
        }
        if (sourceIsLater && !(sourcePhase > 0 && targetPhase > sourcePhase)) {
            return { allowed: false, reason: "downstream-model-transform" };
        }
    }

    // Terminal display/save nodes are consumers. Their pass-through outputs are
    // implementation details and should not be chosen by automatic wiring.
    if (sourceKind === "sink") {
        return { allowed: false, reason: "terminal-source" };
    }

    if (inputRole === "image") {
        const targetFamily = controlFamily(target);
        const sourceFamily = controlFamily(source);
        const sinkIntent = sinkImageIntent(target);
        const sourceRoles = semanticRoles(reasonerText(source));

        // If a Pose/Depth/etc preprocessor has an explicitly labelled reference
        // image in the selection, that reference owns the preprocessor input.
        // This remains permissive for generated-image -> preprocessor workflows
        // when no dedicated reference exists (for example Krea2 -> DWPose).
        if (targetKind === "preprocess" && targetFamily
            && hasExplicitFamilyReferenceProducer(ctx, target, inputIndex, targetFamily)) {
            if (sourceFamily !== targetFamily || (!sourceRoles.has("reference") && !sourceRoles.has("raw"))) {
                return { allowed: false, reason: `preprocess-reference:${targetFamily}` };
            }
        }

        // Terminal IMAGE consumers have a data contract of their own. A SaveImage
        // or explicitly-final Preview should prefer an actual generated/decode/
        // post-process result and must not be hijacked by a Pose/Depth/Canny map
        // merely because the sink title also mentions the control method.
        if (targetKind === "sink" && sinkIntent.kind === "final" && hasFinalImageProducer(ctx, target, inputIndex)) {
            if (sourceStage === DataStage.CONTROL_SIGNAL || sourceKind === "preprocess") {
                return { allowed: false, reason: "final-sink-control-signal" };
            }
            if (sourceStage === DataStage.RAW_INPUT) {
                return { allowed: false, reason: "final-sink-raw-input" };
            }
        }

        // Explicit control-map sinks (for example "Preview | Pose Control Map")
        // keep the opposite contract: if the matching preprocessor exists, only
        // that family is accepted. Generic previews remain governed by soft score.
        if (targetKind === "sink" && sinkIntent.kind === "control"
            && sinkIntent.family && hasMatchingControlProducer(ctx, target, inputIndex, sinkIntent.family)) {
            if (sourceKind !== "preprocess" || sourceFamily !== sinkIntent.family) {
                return { allowed: false, reason: `sink-control-family:${sinkIntent.family}` };
            }
        }

        // When the target explicitly asks for Pose/Depth/Canny/etc. and a
        // matching preprocessor exists in the selection, generic IMAGE sources
        // are not merely lower quality candidates: they are the wrong semantic
        // product. This fixes IMAGE-overload without banning legitimate raw
        // images when no matching preprocessor exists.
        if (targetKind !== "preprocess" && targetKind !== "sink" && targetFamily
            && hasMatchingControlProducer(ctx, target, inputIndex, targetFamily)) {
            if (sourceKind !== "preprocess" || sourceFamily !== targetFamily) {
                return { allowed: false, reason: `image-family:${targetFamily}` };
            }
        }

        // img2img / VAE encode targets should not accidentally encode a
        // Pose/Depth/Canny map when an ordinary image producer is available.
        const targetRoles = semanticRoles(reasonerText(target));
        if (targetKind === "encode" && (targetRoles.has("i2i") || /img2img|\u91cd\u7ed8/.test(reasonerText(target).toLowerCase()))) {
            if (sourceStage === DataStage.CONTROL_SIGNAL && hasNonControlImageProducer(ctx, target, inputIndex)) {
                return { allowed: false, reason: "img2img-control-signal" };
            }
            if (sourceFamily && hasOrdinaryImageProducer(ctx, target, inputIndex)) {
                return { allowed: false, reason: "img2img-control-reference" };
            }
        }
    }

    return { allowed: true };
}


function wouldCreateCycle(source, target) {
    if (source === target) return true;
    const wantedId = String(source.id);
    const queue = [target];
    const visited = new Set();
    while (queue.length) {
        const node = queue.shift();
        const id = String(node.id);
        if (id === wantedId) return true;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const output of node.outputs ?? []) {
            for (const linkId of output.links ?? []) {
                const link = app.graph?.links?.[linkId];
                const next = link ? app.graph.getNodeById(link.target_id) : null;
                if (next && !visited.has(String(next.id))) queue.push(next);
            }
        }
    }
    return false;
}


function titleNamespace(value) {
    const raw = String(value ?? "").trim();
    const match = /^([^｜|:：]{2,40})[｜|:：]/.exec(raw);
    if (!match) return null;
    const generic = new Set([
        "control", "controlnet", "lllite", "model", "stage", "branch", "pipeline",
        "pose", "depth", "canny", "image", "video", "final", "output", "preview", "save",
        "\u7ed3\u6784", "\u63d0\u53d6", "\u9884\u89c8", "\u4fdd\u5b58", "\u63a7\u5236", "\u6700\u7ec8", "\u8f93\u51fa",
    ]);
    const words = semanticWords(match[1]).filter((word) => word && !generic.has(word.toLowerCase()));
    // The first non-generic token is the stable model/branch family: Krea2,
    // Anima, FINAL-01 (handled earlier by titleIdentity), etc. This keeps
    // "Krea2" compatible with "Krea2 Control" and "Anima" with "Anima LLLite".
    return words[0]?.toLowerCase() ?? null;
}

function explicitBranchCompatible(source, target) {
    const s = titleIdentity(source?.title);
    const t = titleIdentity(target?.title);
    if (s.lane && t.lane) {
        return s.lane.family === t.lane.family && s.lane.id === t.lane.id;
    }
    const sourceNs = titleNamespace(source?.title);
    const targetNs = titleNamespace(target?.title);
    if (sourceNs && targetNs) return sourceNs === targetNs;
    return true;
}

function modelTransformChainScore(source, target, inputIndex, ctx = _reasonerCache) {
    const input = target?.inputs?.[inputIndex];
    if (!input || slotSemantic(input.name ?? input.label) !== "model" || !ctx) return 0;

    const sourceKind = nodeArchetype(source);
    const targetKind = nodeArchetype(target);
    if (sourceKind !== "adapter" && sourceKind !== "loader") return 0;

    const targetRoles = semanticRoles(nodeText(target));
    const sourceRoles = semanticRoles(nodeText(source));
    // Refiner samplers intentionally switch to the dedicated refiner MODEL;
    // a same-lane base/IPAdapter chain must not override that stage boundary.
    if (targetKind === "sampler" && targetRoles.has("refiner")) {
        if (sourceKind === "adapter" && !sourceRoles.has("refiner")) return -2600;
        return 0;
    }

    // For sampler MODEL inputs, prefer the most semantically downstream model
    // transformer in the same explicit branch, even if the canvas geometry is
    // slightly reversed. This covers LoRA -> Control Apply / LLLite -> Sampler
    // without naming individual third-party node classes.
    if (targetKind === "sampler" && sourceKind === "adapter") {
        const sameBranchAdapters = ctx.outputs.filter((entry) => entry.kind === "adapter"
            && normalizeType(entry.type).includes("MODEL")
            && entry.node !== target
            && explicitBranchCompatible(entry.node, target));
        const maxPhase = sameBranchAdapters.reduce((best, entry) => Math.max(best, modelTransformPhase(entry.node)), 0);
        const sourcePhase = modelTransformPhase(source);
        if (maxPhase > 0) {
            const maxPhaseAdapters = sameBranchAdapters.filter((entry) => modelTransformPhase(entry.node) === maxPhase);
            if (sourcePhase < maxPhase) return -900;
            // Only use phase as a decisive winner when it identifies one unique
            // terminal transform. If several Apply nodes share the same phase
            // (for example Pose LLLite -> Depth LLLite), fall through to the
            // existing ordered-chain logic so their internal sequence is kept.
            if (sourcePhase === maxPhase && maxPhaseAdapters.length === 1) return 2200;
        }
    }

    const tx = target?.pos?.[0] ?? 0;
    const ty = target?.pos?.[1] ?? 0;
    const isUpstream = (node) => {
        const x = node?.pos?.[0] ?? 0;
        const y = node?.pos?.[1] ?? 0;
        return x < tx - 12 || (Math.abs(x - tx) <= 12 && y < ty - 12);
    };
    const adapters = ctx.outputs
        .filter((entry) => entry.kind === "adapter"
            && normalizeType(entry.type).includes("MODEL")
            && entry.node !== target
            && isUpstream(entry.node)
            && explicitBranchCompatible(entry.node, target))
        .sort((a, b) => {
            const ax = a.node?.pos?.[0] ?? 0;
            const bx = b.node?.pos?.[0] ?? 0;
            if (Math.abs(ax - bx) > 12) return bx - ax;
            return (b.node?.pos?.[1] ?? 0) - (a.node?.pos?.[1] ?? 0);
        });

    const nearestUpstreamAdapter = adapters[0]?.node ?? null;

    if (targetKind === "adapter") {
        if (nearestUpstreamAdapter) {
            if (source === nearestUpstreamAdapter) return 2600;
            if (sourceKind === "loader") return -900;
            if (sourceKind === "adapter") return -1200;
        } else if (sourceKind === "loader") {
            return 900;
        }
    }

    if (targetKind === "sampler" && nearestUpstreamAdapter) {
        if (source === nearestUpstreamAdapter) return 1800;
        if (sourceKind === "adapter") return -650;
    }
    return 0;
}

function globalCandidateScore(source, outputIndex, target, inputIndex, reusedForTarget = false) {
    const gate = validateHardConstraints(source, outputIndex, target, inputIndex);
    if (!gate.allowed) return -Infinity;
    const base = pairScore(source, outputIndex, target, inputIndex, replaceConnectedInputs);
    if (base === -Infinity || wouldCreateCycle(source, target)) return -Infinity;

    const output = source.outputs[outputIndex];
    const input = target.inputs[inputIndex];
    const outputPos = slotPosition(source, false, outputIndex);
    const inputPos = slotPosition(target, true, inputIndex);
    const dx = inputPos[0] - outputPos[0];
    const dy = Math.abs(inputPos[1] - outputPos[1]);
    const outputName = normalizeName(output.name ?? output.label);
    const inputName = normalizeName(input.name ?? input.label);
    const exactType = normalizeType(output.type) === normalizeType(input.type);

    let score = base + (exactType ? 720 : 260);
    score += dx >= -12 ? 360 : -900;
    score -= Math.min(Math.abs(dx), 2400) * 0.12;
    score -= Math.min(dy, 1800) * 0.08;
    if (outputName && inputName) {
        if (outputName === inputName) score += 360;
        else if (outputName.includes(inputName) || inputName.includes(outputName)) score += 150;
    }
    score += structuralIdentityScore(source, target, outputIndex, inputIndex);
    score += conditioningPolarityScore(source, outputIndex, target, inputIndex);
    score += titleAffinityScore(source, target);
    score += inputRoleScore(source, outputIndex, target, inputIndex);
    score += producerRoleScore(source, outputIndex, target, inputIndex);
    score += modelTransformChainScore(source, target, inputIndex);
    score += finalImageStageScore(source, target, inputIndex);
    score += rootResourceScore(source, target, outputIndex);
    if (reusedForTarget) score -= 520;
    return score;
}

function compatibleOutputsForInput(nodes, inputType, compatibilityCache) {
    const key = normalizeType(inputType);
    if (compatibilityCache.has(key)) return compatibilityCache.get(key);
    const entries = [];
    for (const source of nodes) {
        for (let outputIndex = 0; outputIndex < (source.outputs?.length ?? 0); outputIndex++) {
            const output = source.outputs[outputIndex];
            if (output && typesCompatible(output.type, inputType)) entries.push({ source, outputIndex });
        }
    }
    compatibilityCache.set(key, entries);
    return entries;
}


function candidateEvidenceScore(candidate, target, inputIndex) {
    if (!candidate) return 0;
    let evidence = 0;
    const structural = structuralIdentityScore(candidate.source, target, candidate.outputIndex, inputIndex);
    const producer = producerRoleScore(candidate.source, candidate.outputIndex, target, inputIndex);
    const transform = modelTransformChainScore(candidate.source, target, inputIndex);
    const finalStage = finalImageStageScore(candidate.source, target, inputIndex);
    const affinity = titleAffinityScore(candidate.source, target);
    if (structural >= 500) evidence += 3;
    else if (structural >= 180) evidence += 1;
    if (producer >= 1200) evidence += 3;
    else if (producer >= 500) evidence += 1;
    if (transform >= 900) evidence += 3;
    if (finalStage >= 650) evidence += 2;
    if (affinity >= 500) evidence += 2;
    else if (affinity >= 180) evidence += 1;
    return evidence;
}

function shouldAbstainCandidate(rankedPool, target, inputIndex) {
    if (!rankedPool || rankedPool.length < 2) return false;
    const input = target?.inputs?.[inputIndex];
    if (!input) return false;
    const targetKind = nodeArchetype(target);
    // Ordered/aggregate sockets are intentionally interchangeable; the existing
    // distinct-source logic is more useful than abstention there.
    if (targetKind === "composite" || /combine|merge|aggregate|concat/i.test(String(target?.type ?? ""))) return false;

    const type = normalizeType(input.type);
    if (!/(IMAGE|MODEL|MASK)/.test(type)) return false;
    const sameTypeInputs = (target?.inputs ?? []).filter((entry) => normalizeType(entry?.type) === type).length;
    if (sameTypeInputs > 1) return false;

    const sorted = [...rankedPool].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const second = sorted[1];
    if (!best || !second) return false;
    const delta = best.score - second.score;
    const evidence = candidateEvidenceScore(best, target, inputIndex);

    // The rule is deliberately conservative: only abstain when two candidates
    // are genuinely close AND the winner has no strong semantic/structural
    // evidence. This converts silent wrong edges into unresolved inputs without
    // sacrificing clear fan-out or branch-labelled workflows.
    const margin = type.includes("IMAGE") ? 130 : type.includes("MODEL") ? 110 : 80;
    return delta < margin && evidence < 2;
}

function bestGlobalCandidate(nodes, target, inputIndex, usedByTarget, compatibilityCache) {
    const candidates = [];
    const input = target.inputs?.[inputIndex];
    const compatible = input ? compatibleOutputsForInput(nodes, input.type, compatibilityCache) : [];
    for (const entry of compatible) {
        const { source, outputIndex } = entry;
        if (source === target) continue;
        const key = `${source.id}:${outputIndex}`;
        const score = globalCandidateScore(
            source,
            outputIndex,
            target,
            inputIndex,
            usedByTarget.has(key),
        );
        if (score > -Infinity) {
            candidates.push({
                source, target, outputIndex, inputIndex, score, key,
                sourcePolarity: sourcePolarity(source, outputIndex),
                outputY: slotPosition(source, false, outputIndex)[1],
                dx: slotPosition(target, true, inputIndex)[0] - slotPosition(source, false, outputIndex)[0],
            });
        }
    }
    if (!candidates.length) return null;

    // Prefer distinct compatible sources for same-type target inputs. Reuse is
    // still allowed when only one compatible source exists.
    const unused = candidates.filter((candidate) => !usedByTarget.has(candidate.key));
    const pool = unused.length ? unused : candidates;
    // If at least one compatible source is already upstream, do not let a
    // downstream node win only because its title happens to look more similar.
    // Fall back to all candidates for deliberately right-to-left workflows.
    const upstream = pool.filter((candidate) => candidate.dx >= -12);
    const strongDownstream = pool.filter((candidate) => candidate.dx < -12 && (
        candidate.score >= 4500
        || producerRoleScore(candidate.source, candidate.outputIndex, target, inputIndex) >= 1800
        || structuralIdentityScore(candidate.source, target, candidate.outputIndex, inputIndex) >= 4000
    ));
    const rankedPool = upstream.length
        ? [...new Map([...upstream, ...strongDownstream].map((candidate) => [candidate.key, candidate])).values()]
        : pool;

    // When no source has an explicit semantic label, keep vertical placement as
    // a weak fallback only. Explicit positive/negative labels remain stronger.
    const wanted = inputPolarity(target, inputIndex);
    if (wanted !== "neutral") {
        const conditioning = rankedPool.filter((candidate) =>
            normalizeType(candidate.source.outputs?.[candidate.outputIndex]?.type).includes("CONDITIONING")
        );
        const hasExplicitMatch = conditioning.some((candidate) => candidate.sourcePolarity === wanted);
        if (!hasExplicitMatch && conditioning.length > 1) {
            const ys = conditioning.map((candidate) => candidate.outputY);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const span = Math.max(1, maxY - minY);
            for (const candidate of conditioning) {
                if (candidate.sourcePolarity !== "neutral") continue;
                const rank = (candidate.outputY - minY) / span;
                candidate.score += wanted === "positive" ? (1 - rank) * 220 : rank * 220;
            }
        }
    }

    if (shouldAbstainCandidate(rankedPool, target, inputIndex)) return null;
    return rankedPool.reduce((best, candidate) => !best || candidate.score > best.score ? candidate : best, null);
}

function smartConnectSelection() {
    resetCommandSemanticCaches();
    const nodes = selectedNodes().sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);
    if (nodes.length < 2) {
        notify("Select at least two nodes", "warn");
        return false;
    }
    let connected = 0;
    let unresolved = 0;
    const compatibilityCache = new Map();
    activeSelectionContext = identityContext(nodes);
    getReasonerContext(nodes);
    graphChanged(() => {
        for (const target of nodes) {
            const usedByTarget = new Set();
            for (let inputIndex = 0; inputIndex < (target.inputs?.length ?? 0); inputIndex++) {
                const input = target.inputs[inputIndex];
                if (input.link != null && !replaceConnectedInputs) continue;
                const candidate = bestGlobalCandidate(nodes, target, inputIndex, usedByTarget, compatibilityCache);
                if (!candidate) {
                    unresolved++;
                    continue;
                }
                if (connectPair(candidate)) {
                    usedByTarget.add(candidate.key);
                    connected++;
                } else {
                    unresolved++;
                }
            }
        }
    });
    activeSelectionContext = null;
    clearReasonerCache();
    if (connected) {
        const suffix = unresolved
            ? `; ${unresolved} input${unresolved === 1 ? "" : "s"} had no compatible source in the selection`
            : "";
        notify(`Smart-connected ${connected} link${connected === 1 ? "" : "s"}${suffix}`, unresolved ? "info" : "success");
    }
    else notify("No compatible free slots were found", "warn");
    return connected > 0;
}

function linkedInputSnapshot(node, inputIndex) {
    const linkId = node.inputs?.[inputIndex]?.link;
    const link = linkId == null ? null : app.graph?.links?.[linkId];
    if (!link) return null;
    const origin = app.graph.getNodeById(link.origin_id);
    const output = origin?.outputs?.[link.origin_slot];
    return origin && output ? { origin, originSlot: link.origin_slot, type: output.type } : null;
}

function swapLinkedInputs() {
    const node = focusedNodes(1)[0];
    if (!node) {
        notify("Select a node", "warn");
        return false;
    }
    const linked = (node.inputs ?? [])
        .map((input, index) => ({ input, index, snapshot: linkedInputSnapshot(node, index) }))
        .filter((entry) => entry.snapshot);

    let pair = null;
    for (let a = 0; a < linked.length && !pair; a++) {
        for (let b = a + 1; b < linked.length; b++) {
            if (
                typesCompatible(linked[a].snapshot.type, linked[b].input.type) &&
                typesCompatible(linked[b].snapshot.type, linked[a].input.type)
            ) {
                pair = [linked[a], linked[b]];
                break;
            }
        }
    }
    if (!pair) {
        notify("No connected input pair can be swapped safely", "warn");
        return false;
    }

    graphChanged(() => {
        node.disconnectInput(pair[0].index);
        node.disconnectInput(pair[1].index);
        pair[0].snapshot.origin.connect(pair[0].snapshot.originSlot, node, pair[1].index);
        pair[1].snapshot.origin.connect(pair[1].snapshot.originSlot, node, pair[0].index);
    });
    notify(`Swapped ${pair[0].input.name} / ${pair[1].input.name}`, "success");
    return true;
}

function toggleBypass() {
    const nodes = focusedNodes(1);
    if (!nodes.length) {
        notify("Select one or more nodes", "warn");
        return false;
    }
    const restore = nodes.every((node) => node.mode === BYPASS_MODE);
    graphChanged(() => {
        for (const node of nodes) node.mode = restore ? ALWAYS_MODE : BYPASS_MODE;
    });
    notify(restore ? "Restored selected nodes" : "Bypassed selected nodes", "success");
    return true;
}

function arrangeSelection() {
    const nodes = selectedNodes();
    if (nodes.length < 2) {
        notify("Select at least two nodes", "warn");
        return false;
    }

    const nodeSet = new Set(nodes.map((node) => String(node.id)));
    const incoming = new Map(nodes.map((node) => [String(node.id), 0]));
    const outgoing = new Map(nodes.map((node) => [String(node.id), []]));
    for (const node of nodes) {
        for (const output of node.outputs ?? []) {
            for (const linkId of output.links ?? []) {
                const link = app.graph.links?.[linkId];
                if (!link || !nodeSet.has(String(link.target_id))) continue;
                outgoing.get(String(node.id)).push(String(link.target_id));
                incoming.set(String(link.target_id), incoming.get(String(link.target_id)) + 1);
            }
        }
    }

    const levels = new Map();
    const queue = nodes
        .filter((node) => incoming.get(String(node.id)) === 0)
        .sort((a, b) => a.pos[1] - b.pos[1])
        .map((node) => String(node.id));
    while (queue.length) {
        const id = queue.shift();
        const level = levels.get(id) ?? 0;
        for (const targetId of outgoing.get(id) ?? []) {
            levels.set(targetId, Math.max(levels.get(targetId) ?? 0, level + 1));
            incoming.set(targetId, incoming.get(targetId) - 1);
            if (incoming.get(targetId) === 0) queue.push(targetId);
        }
    }
    for (const node of nodes) {
        const id = String(node.id);
        if (!levels.has(id)) levels.set(id, Math.max(0, Math.round(node.pos[0] / 300)));
    }

    const oldCenter = nodes.reduce((acc, node) => [acc[0] + node.pos[0], acc[1] + node.pos[1]], [0, 0]);
    oldCenter[0] /= nodes.length;
    oldCenter[1] /= nodes.length;
    const columns = new Map();
    for (const node of nodes) {
        const level = levels.get(String(node.id));
        if (!columns.has(level)) columns.set(level, []);
        columns.get(level).push(node);
    }

    let x = 0;
    const positions = new Map();
    for (const level of [...columns.keys()].sort((a, b) => a - b)) {
        const column = columns.get(level).sort((a, b) => a.pos[1] - b.pos[1]);
        const width = Math.max(...column.map((node) => node.size?.[0] ?? 180));
        let y = 0;
        for (const node of column) {
            positions.set(node, [x, y]);
            y += (node.size?.[1] ?? 100) + 55;
        }
        const height = y - 55;
        for (const node of column) positions.get(node)[1] -= height / 2;
        x += width + 110;
    }

    const newCenter = [...positions.values()].reduce((acc, pos) => [acc[0] + pos[0], acc[1] + pos[1]], [0, 0]);
    newCenter[0] /= nodes.length;
    newCenter[1] /= nodes.length;
    graphChanged(() => {
        for (const [node, pos] of positions) {
            node.pos[0] = pos[0] + oldCenter[0] - newCenter[0];
            node.pos[1] = pos[1] + oldCenter[1] - newCenter[1];
        }
    });
    notify(`Arranged ${nodes.length} node${nodes.length === 1 ? "" : "s"} by data flow`, "success");
    return true;
}

function addReroutesAfterSelection() {
    const nodes = focusedNodes(1);
    const rerouteType = LiteGraph.registered_node_types?.Reroute ? "Reroute" : null;
    if (!nodes.length || !rerouteType) {
        notify(rerouteType ? "Select one or more nodes" : "No Reroute node type is available in this frontend", "warn");
        return false;
    }
    let created = 0;
    graphChanged(() => {
        for (const source of nodes) {
            for (let outputIndex = 0; outputIndex < (source.outputs?.length ?? 0); outputIndex++) {
                const output = source.outputs[outputIndex];
                const links = (output.links ?? [])
                    .map((id) => app.graph.links?.[id])
                    .filter(Boolean)
                    .map((link) => ({ targetId: link.target_id, targetSlot: link.target_slot }));
                if (!links.length) continue;

                const reroute = LiteGraph.createNode(rerouteType);
                if (!reroute) continue;
                app.graph.add(reroute);
                reroute.pos = [
                    source.pos[0] + (source.size?.[0] ?? 180) + 65,
                    source.pos[1] + 35 + outputIndex * 28,
                ];
                source.disconnectOutput(outputIndex);
                source.connect(outputIndex, reroute, 0);
                for (const link of links) reroute.connect(0, link.targetId, link.targetSlot);
                created++;
            }
        }
    });
    notify(
        created
            ? `Inserted ${created} fan-out reroute point${created === 1 ? "" : "s"}`
            : "The selected nodes have no output links",
        created ? "success" : "warn",
    );
    return created > 0;
}

function commandOptions() {
    return [
        { content: "Smart-connect selected nodes", callback: smartConnectSelection },
        { content: "Swap two inputs on the current node", callback: swapLinkedInputs },
        { content: "Insert output reroute points", callback: addReroutesAfterSelection },
        { content: "Arrange selected nodes by data flow", callback: arrangeSelection },
        null,
        { content: "Bypass / restore selected nodes", callback: toggleBypass },
    ];
}

function showCommandMenu(event = null) {
    const menuEvent = event ?? new MouseEvent("contextmenu", {
        clientX: lastPointer.clientX,
        clientY: lastPointer.clientY,
        bubbles: true,
    });
    new LiteGraph.ContextMenu(commandOptions(), {
        event: menuEvent,
        title: "Flow Wrangler",
    });
}

function patchCanvasMenu() {
    if (LGraphCanvas.prototype.__flowWranglerMenuPatched) return;
    LGraphCanvas.prototype.__flowWranglerMenuPatched = true;
    const original = LGraphCanvas.prototype.getCanvasMenuOptions;
    LGraphCanvas.prototype.getCanvasMenuOptions = function () {
        const options = original?.apply(this, arguments) ?? [];
        options.push(null, {
            content: "Flow Wrangler",
            has_submenu: true,
            submenu: { title: "Flow Wrangler", options: commandOptions() },
        });
        return options;
    };
}

function patchNodeMenus(nodeType) {
    const original = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_, options) {
        original?.apply(this, arguments);
        options.unshift({
            content: "Flow Wrangler",
            has_submenu: true,
            submenu: { title: "Flow Wrangler", options: commandOptions() },
        });
    };
}

function ensureGestureOverlay() {
    if (gestureOverlay) return gestureOverlay;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;pointer-events:none;display:none";
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", "#6ee7ff");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-dasharray", "8 6");
    line.style.filter = "drop-shadow(0 0 4px #22d3ee)";
    svg.appendChild(line);
    document.body.appendChild(svg);
    gestureOverlay = { svg, line };
    return gestureOverlay;
}

function eventPosition(event) {
    try {
        return app.canvas.convertEventToCanvasOffset(event);
    } catch (_) {
        return app.canvas.graph_mouse;
    }
}

function nodeAtEvent(event) {
    const pos = eventPosition(event);
    return app.graph?.getNodeOnPos?.(pos[0], pos[1], app.graph._nodes, 5) ?? null;
}

function installLazyConnectGesture() {
    const canvasElement = app.canvas?.canvas;
    if (!canvasElement || canvasElement.__flowWranglerGestureInstalled) return;
    canvasElement.__flowWranglerGestureInstalled = true;
    const overlay = ensureGestureOverlay();

    canvasElement.addEventListener("pointermove", (event) => {
        lastPointer = { clientX: event.clientX, clientY: event.clientY };
    }, true);

    canvasElement.addEventListener("pointerdown", (event) => {
        if (!gestureEnabled || event.button !== 2 || !event.altKey) {
            if (pendingClickSource) {
                pendingClickSource = null;
                overlay.svg.style.display = "none";
            }
            return;
        }
        const source = nodeAtEvent(event);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!source) {
            pendingClickSource = null;
            overlay.svg.style.display = "none";
            suppressContextMenuUntil = performance.now() + 350;
            notify("Alt + right-click connection cancelled", "info");
            return;
        }
        lazyGesture = { source, startX: event.clientX, startY: event.clientY, moved: false };
        overlay.svg.style.display = "block";
        if (!pendingClickSource) {
            overlay.line.setAttribute("x1", String(event.clientX));
            overlay.line.setAttribute("y1", String(event.clientY));
        }
        overlay.line.setAttribute("x2", String(event.clientX));
        overlay.line.setAttribute("y2", String(event.clientY));
    }, true);

    window.addEventListener("pointermove", (event) => {
        if (lazyGesture) {
            const distance = Math.hypot(event.clientX - lazyGesture.startX, event.clientY - lazyGesture.startY);
            if (!lazyGesture.moved && distance > 6) {
                lazyGesture.moved = true;
                pendingClickSource = null;
                overlay.line.setAttribute("x1", String(lazyGesture.startX));
                overlay.line.setAttribute("y1", String(lazyGesture.startY));
            }
        } else if (!pendingClickSource) {
            return;
        }
        overlay.line.setAttribute("x2", String(event.clientX));
        overlay.line.setAttribute("y2", String(event.clientY));
    }, true);

    window.addEventListener("pointerup", (event) => {
        if (!lazyGesture || event.button !== 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const gesture = lazyGesture;
        lazyGesture = null;
        suppressContextMenuUntil = performance.now() + 350;
        const target = nodeAtEvent(event);

        if (!gesture.moved) {
            const clickedNode = target ?? gesture.source;
            if (!pendingClickSource) {
                pendingClickSource = {
                    node: clickedNode,
                    clientX: event.clientX,
                    clientY: event.clientY,
                };
                overlay.svg.style.display = "block";
                overlay.line.setAttribute("x1", String(event.clientX));
                overlay.line.setAttribute("y1", String(event.clientY));
                overlay.line.setAttribute("x2", String(event.clientX));
                overlay.line.setAttribute("y2", String(event.clientY));
                notify(`Source selected: ${clickedNode.title ?? clickedNode.type}. Alt + right-click a target node`, "info");
                return;
            }

            const source = pendingClickSource.node;
            pendingClickSource = null;
            overlay.svg.style.display = "none";
            if (!clickedNode || clickedNode === source) {
                notify("Alt + right-click connection cancelled", "info");
                return;
            }
            let connected = false;
            graphChanged(() => {
                connected = smartConnectBetween(source, clickedNode, true);
            });
            notify(connected ? "Alt + right-click connection completed" : "The two nodes have no compatible slots", connected ? "success" : "warn");
            return;
        }

        pendingClickSource = null;
        overlay.svg.style.display = "none";
        if (!target || target === gesture.source) return;
        let connected = false;
        graphChanged(() => {
            connected = smartConnectBetween(gesture.source, target, true);
        });
        notify(connected ? "Alt + right-drag connection completed" : "The two nodes have no compatible slots", connected ? "success" : "warn");
    }, true);

    canvasElement.addEventListener("contextmenu", (event) => {
        if (lazyGesture || performance.now() < suppressContextMenuUntil || (pendingClickSource && event.altKey)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}

app.registerExtension({
    name: EXTENSION_NAME,

    commands: [
        { id: "flow-wrangler.smart-connect", label: "Flow Wrangler: Smart-connect selected nodes", function: smartConnectSelection },
        { id: "flow-wrangler.swap-inputs", label: "Flow Wrangler: Swap inputs", function: swapLinkedInputs },
        { id: "flow-wrangler.add-reroutes", label: "Flow Wrangler: Insert output reroute points", function: addReroutesAfterSelection },
        { id: "flow-wrangler.arrange", label: "Flow Wrangler: Arrange selected nodes", function: arrangeSelection },
        { id: "flow-wrangler.toggle-bypass", label: "Flow Wrangler: Bypass / restore nodes", function: toggleBypass },
        { id: "flow-wrangler.show-menu", label: "Flow Wrangler: Open quick menu", function: showCommandMenu },
    ],

    keybindings: [
        {
            combo: { shift: true, key: "w" },
            commandId: "flow-wrangler.smart-connect",
            targetElementId: "graph-canvas-container",
        },
        {
            combo: { shift: true, key: "s" },
            commandId: "flow-wrangler.swap-inputs",
            targetElementId: "graph-canvas-container",
        },
    ],

    settings: [
        {
            id: SETTING_GESTURE,
            name: "Flow Wrangler: Enable Alt + right-click / right-drag smart connection",
            type: "boolean",
            defaultValue: true,
            onChange(value) { gestureEnabled = value !== false; },
        },
        {
            id: SETTING_REPLACE,
            name: "Flow Wrangler: Allow smart connection to replace existing inputs",
            type: "boolean",
            defaultValue: false,
            onChange(value) { replaceConnectedInputs = value === true; },
        },
    ],

    menuCommands: [
        {
            path: ["Edit", "Flow Wrangler"],
            commands: [
                "flow-wrangler.smart-connect",
                "flow-wrangler.swap-inputs",
                "flow-wrangler.add-reroutes",
                "flow-wrangler.arrange",
                "flow-wrangler.toggle-bypass",
            ],
        },
    ],

    async beforeRegisterNodeDef(nodeType) {
        patchNodeMenus(nodeType);
    },

    async setup() {
        gestureEnabled = app.ui.settings.getSettingValue(SETTING_GESTURE) !== false;
        replaceConnectedInputs = app.ui.settings.getSettingValue(SETTING_REPLACE) === true;
        patchCanvasMenu();
        installLazyConnectGesture();
        console.info(`[Flow Wrangler] v${EXTENSION_VERSION} loaded (modern frontend keybindings enabled)`);
    },
});
