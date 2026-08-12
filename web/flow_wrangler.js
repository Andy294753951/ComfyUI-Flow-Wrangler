import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXTENSION_NAME = "Comfy.FlowWrangler";
const EXTENSION_VERSION = "0.4.0";
const SETTING_GESTURE = `${EXTENSION_NAME}.LazyConnectGesture`;
const SETTING_REPLACE = `${EXTENSION_NAME}.ReplaceConnectedInputs`;
const SETTING_AI_ENABLED = `${EXTENSION_NAME}.AIEnabled`;
const SETTING_AI_MODEL = `${EXTENSION_NAME}.AIModel`;
const SETTING_AI_FORCE_OLLAMA = `${EXTENSION_NAME}.AIForceOllama`;
const DEFAULT_AI_MODEL = "qwen3:4b";
const AI_MIN_CONFIDENCE = 0.72;
const MAX_AI_CANDIDATES = 4096;
const BYPASS_MODE = 4;
const ALWAYS_MODE = 0;

let gestureEnabled = true;
let replaceConnectedInputs = false;
let aiEnabled = false;
let aiModel = DEFAULT_AI_MODEL;
let aiForceOllama = false;
let aiRequestActive = false;
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
    add("reference", /\b(reference|ref)\b|ref\d|ref2va|\u53c2\u8003|\u53c2\u7167/);
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
    add("initial", /\b(first|initial|opening)\b|\u9996\u6bb5|\u9996\u5e27|\u8d77\u59cb/);
    add("continuation", /\b(continue|continuation|extend|next)\b|motion.?context|\u7eed\u5199|\u7eed\u7247|\u5ef6\u7eed/);
    add("directory", /\b(directory|folder|path)\b|\u76ee\u5f55|\u8def\u5f84/);
    add("prefix", /\b(prefix)\b|\u524d\u7f00/);
    add("seed", /\bseed\b|\u79cd\u5b50/);
    add("index", /\b(index|count)\b|\u7d22\u5f15|\u6b21\u6570/);
    add("load", /\b(load|loader|read)\b|\u52a0\u8f7d|\u8bfb\u53d6/);
    add("save", /\b(save|writer|write)\b|\u4fdd\u5b58|\u5199\u5165/);
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
    if (type.includes("saveimage") || type.includes("previewimage") || type.includes("previewany")
        || type.includes("showanything") || type.includes("displayanything") || type.includes("savevideo")
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
    const hasLatentInput = [...inputNames].some((name) => name.includes("latent"));
    const hasConditioningInput = inputNames.has("conditioning") || inputNames.has("positive");
    const hasGeneratedMediaOutput = [...outputTypes].some((value) => /IMAGE|VIDEO|AUDIO/.test(value));
    if (hasLatentInput && hasConditioningInput && hasGeneratedMediaOutput) return "sampler";
    if (type.includes("ksampler") || type.includes("sampler") || type.includes("videodiffusion")
        || /\b(txt2img|text.?to.?image)\b/.test(text)) return "sampler";
    if (type.includes("vaedecode") || type.includes("wanvideodecode") || type.includes("latentdecode")
        || /\bdecode\b/.test(text)) return "decode";
    if (type.includes("vaeencode") || type.includes("wanvideoencode") || type.includes("latentencode")
        || (type.includes("encode") && !type.includes("textencode")) || /\bencode\b/.test(text)) return "encode";
    if (type.includes("upscale") || type.includes("superresolution")
        || /\b(upscale|upscaler|hires|superres|super.?resolution)\b/.test(text)) return "upscale";
    // Model-transform adapters (including Anima LLLite) consume MODEL + patch/image
    // and produce a transformed MODEL. Classify them before generic animation text
    // matching so chained model transforms preserve their causal order.
    if (type.includes("ipadapter") || type.includes("llliteapply") || /\b(adapter)\b/.test(text)
        || (inputNames.has("model") && inputNames.has("modelpatch") && outputTypes.has("MODEL"))) return "adapter";
    if (type.includes("controlnetapply") || type.includes("applycontrolnet") || /\bcontrol.?apply\b/.test(text)) return "control";
    if (type.includes("openpose") || type.includes("preprocessor") || type.includes("preprocess")
        || (rawControlFamilyFromText(type) && inputNames.has("image") && outputTypes.has("IMAGE")
            && !type.includes("encode") && !type.includes("apply"))) return "preprocess";
    if (type.includes("composite") || type.includes("blend") || type.includes("merge")
        || type.includes("combine") || type.includes("concat")
        || type.includes("colormatch") || /\b(composite|blend|merge|combine|concat|color\s*match)\b/.test(text)) return "composite";
    if (type.includes("clipsetlastlayer") || type.includes("cliptextencode") || type.includes("textencode")
        || type.includes("conditioningcombine") || /\bconditioning\b/.test(type)) return "conditioning";
    if (type === "setnode" || type === "getnode" || type.includes("switch") || type.includes("router")) return "routing";
    if (type.includes("animation") || type.includes("anima") || /\b(anima|animate|video output|final video)\b/.test(text)) return "animation";
    return "transform";
}

function slotSemantic(value) {
    const text = String(value ?? "").toLowerCase();
    const name = normalizeName(value);
    // ComfyUI commonly uses underscore/dotted socket paths (`audio_vae`,
    // `ref_images.ref_image_0`). JavaScript word boundaries do not split on an
    // underscore, so handle those normalized contracts before the prose regex.
    if (name.includes("latent") || name === "samples" || name === "sample") return "latent";
    if (name.includes("image") || name === "pixels" || name === "pixel"
        || name === "firstframe" || name === "lastframe") return "image";
    if (name.includes("mask")) return "mask";
    if (name === "model" || name.endsWith("model") || name.startsWith("modeltooffload")) return "model";
    if (name.includes("vae")) return "vae";
    if (name.includes("conditioning") || name === "positive" || name === "negative"
        || name === "uncond" || name === "textembeds") return "conditioning";
    if (name.includes("audio") || name.includes("sound")) return "audio";
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
            if (LiteGraph.isValidConnection(outputType, inputType)) return true;
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

function serializedWidgetEntries(node) {
    const values = node?.widgets_values;
    if (Array.isArray(values)) return values.map((value, index) => [`widget_${index}`, value]);
    if (values && typeof values === "object") return Object.entries(values);
    return [];
}

function reasonerText(node, includeWidgets = false) {
    const shortWidgets = includeWidgets
        ? serializedWidgetEntries(node)
            .map(([, value]) => value)
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
        || ((type.includes("videocombine") || type.includes("videowriter")) && roles.has("save"))
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

function dimensionAxis(value) {
    const name = normalizeName(value);
    if (!name) return null;
    if (/(?:^|[^a-z])width(?:$|[^a-z])/.test(String(value ?? "").toLowerCase()) || name === "width") return "width";
    if (/(?:^|[^a-z])height(?:$|[^a-z])/.test(String(value ?? "").toLowerCase()) || name === "height") return "height";
    if (name === "batchsize" || name === "batch") return "batch";
    if (name === "length" || name === "frames" || name === "framecount") return "length";
    return null;
}

function dimensionAxisForOutput(node, outputIndex) {
    const output = node?.outputs?.[outputIndex];
    const direct = dimensionAxis(output?.name ?? output?.label);
    if (direct) return direct;
    const inputAxes = (node?.inputs ?? []).map((input) => dimensionAxis(input?.name ?? input?.label));
    if (inputAxes.includes("width") && inputAxes.includes("height")) {
        const scalarOutputs = (node?.outputs ?? [])
            .map((slot, index) => ({ index, type: normalizeType(slot?.type) }))
            .filter((entry) => /^(INT|FLOAT)$/.test(entry.type));
        const ordinal = scalarOutputs.findIndex((entry) => entry.index === outputIndex);
        if (ordinal === 0) return "width";
        if (ordinal === 1) return "height";
    }
    return null;
}

function modalityFromText(value) {
    const text = String(value ?? "").toLowerCase();
    if (/audio[_\s-]*vae|vae[_\s-]*audio|audio.*\.safetensors/.test(text)) return "audio";
    if (/video[_\s-]*vae|vae[_\s-]*video|video.*\.safetensors/.test(text)) return "video";
    if (/image[_\s-]*vae|vae[_\s-]*image/.test(text)) return "image";
    return null;
}

function vaeModalityForSource(node, outputIndex) {
    const output = node?.outputs?.[outputIndex];
    const explicit = modalityFromText(`${output?.name ?? ""} ${output?.label ?? ""}`);
    if (explicit) return explicit;

    // Multi-model loaders often expose several identically typed VAE sockets
    // whose semantic names survive only in their filename widgets. Pair the
    // VAE output ordinal with the VAE widget ordinal before falling back to the
    // node-level text, which would incorrectly label every socket as audio.
    const vaeOutputs = (node?.outputs ?? [])
        .map((slot, index) => ({ slot, index }))
        .filter((entry) => normalizeType(entry.slot?.type) === "VAE");
    const vaeOrdinal = vaeOutputs.findIndex((entry) => entry.index === outputIndex);
    if (vaeOrdinal >= 0) {
        const vaeWidgets = serializedWidgetEntries(node)
            .map(([, value]) => value)
            .filter((value) => typeof value === "string" && /vae/i.test(value));
        const byOrdinal = modalityFromText(vaeWidgets[vaeOrdinal]);
        if (byOrdinal) return byOrdinal;
    }

    const text = reasonerText(node, true).toLowerCase();
    return modalityFromText(text);
}

function vaeModalityForTarget(target, input) {
    const inputName = normalizeName(input?.name ?? input?.label);
    const text = `${target?.type ?? ""} ${target?.title ?? ""}`.toLowerCase();
    if (inputName.includes("audiovae") || /vaedecodeaudio|audiovaedecode/.test(text)) return "audio";
    if (/^vae\d+$/.test(inputName) && (target?.outputs ?? []).some((output) => normalizeType(output?.type).includes("AUDIO"))) {
        return "audio";
    }
    if (inputName === "vae" && (/video|image/.test(text) || /vaedecode/.test(text))) return "visual";
    if (inputName === "vae" && (target?.outputs ?? []).some((output) => /IMAGE|VIDEO/.test(normalizeType(output?.type)))) {
        return "visual";
    }
    return null;
}

function indexedInputFamily(input) {
    const name = normalizeName(input?.name ?? input?.label);
    if (!name) return null;
    if (name.startsWith("refvideoaudiosrefvideoaudio")) return "reference-video-audio";
    if (name.startsWith("refaudiosrefaudio")) return "reference-audio";
    if (name.startsWith("refvideosrefvideo")) return "reference-video";
    if (name.startsWith("refimagesrefimage")) return "reference-image";
    if (name === "firstframe" || name === "lastframe") return "endpoint-frame";
    if (/^image\d+$/.test(name)) return "aggregate-image";
    if (/^any\d+$/.test(name)) return "switch-input";
    return null;
}

function aiWidgetCandidateAllowed(source, outputIndex, target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    const output = source?.outputs?.[outputIndex];
    if (!input?.widget || !output) return true;
    const sourceName = normalizeName(output.name ?? output.label);
    const targetName = normalizeName(input.name ?? input.label);
    if (sourceName && targetName && sourceName === targetName) return true;
    const targetAxis = dimensionAxis(input.name ?? input.label);
    const sourceAxis = dimensionAxisForOutput(source, outputIndex);
    if (targetAxis && sourceAxis === targetAxis) return true;
    const sourceText = reasonerText(source, false).toLowerCase();
    if (targetAxis && /conditional.*branch|branch.*conditional|select|switch/.test(sourceText)) return true;
    if ((targetName === "length" || targetName === "framecount" || targetName === "frames")
        && /math|expression|frame.?count|length/.test(sourceText)) return true;
    if (targetName === "cond" && isScalarConditionalBranch(target)
        && normalizeType(output.type) === "BOOLEAN") return true;
    if ((targetName === "prompt" || targetName === "text")
        && normalizeType(output.type) === "STRING"
        && /primitive.*string|string.*primitive|prompt|text/.test(sourceText)) return true;
    // Converted widgets are regular graph sockets once a cable is present.
    // Exact runtime types are safe to expose to the AI candidate resolver; the
    // deterministic fallback still leaves generic scalar widgets untouched.
    return typesCompatible(output.type, input.type);
}

function aiInputEligible(target, input) {
    if (!input) return false;
    const targetText = `${target?.type ?? ""} ${target?.title ?? ""}`.toLowerCase();
    if (/deprecated|abandoned|unused|\u5df2\u5f03\u7528|\u5e9f\u5f03\u8282\u70b9/.test(targetText)) return false;
    if (!input.widget) return true;

    // A converted widget is present in `node.inputs`; an ordinary UI-only
    // widget is not. Every type-valid converted widget is therefore a real
    // graph socket and must remain available to the local resolver.
    return true;
}

function selectedReasonerNodes() {
    return activeSelectionContext?.all?.map((entry) => entry.node) ?? [];
}

function isScalarConditionalBranch(node) {
    const inputs = new Set((node?.inputs ?? []).map((input) => normalizeName(input?.name ?? input?.label)));
    const output = node?.outputs?.[0];
    return inputs.has("ttvalue") && inputs.has("ffvalue") && inputs.has("cond")
        && Boolean(output) && /^(INT|FLOAT)$/.test(normalizeType(output.type));
}

function inferredConditionalAxis(node) {
    if (!isScalarConditionalBranch(node)) return null;
    const nodes = selectedReasonerNodes();
    const siblings = nodes.filter((candidate) => candidate?.type === node?.type && isScalarConditionalBranch(candidate));
    if (siblings.length !== 2) return null;
    const producerAxes = new Set(nodes.flatMap((candidate) => (candidate?.outputs ?? [])
        .map((output) => dimensionAxis(output?.name ?? output?.label)).filter(Boolean)));
    const consumerAxes = new Set(nodes.flatMap((candidate) => (candidate?.inputs ?? [])
        .map((input) => dimensionAxis(input?.name ?? input?.label)).filter(Boolean)));
    if (!producerAxes.has("width") || !producerAxes.has("height")
        || !consumerAxes.has("width") || !consumerAxes.has("height")) return null;
    siblings.sort((a, b) => (Number.isFinite(a?.order) ? a.order : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(b?.order) ? b.order : Number.MAX_SAFE_INTEGER)
        || (a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0)
        || (a.pos?.[1] ?? 0) - (b.pos?.[1] ?? 0));
    return siblings[0] === node ? "width" : "height";
}

function inferredScalarDisplayAxis(node) {
    const type = String(node?.type ?? "").toLowerCase();
    if (!/show.*anything|display.*anything|debug.*value/.test(type)) return null;
    const nodes = selectedReasonerNodes();
    const siblings = nodes.filter((candidate) => String(candidate?.type ?? "").toLowerCase() === type);
    if (siblings.length !== 2) return null;
    const producerAxes = new Set(nodes.flatMap((candidate) => (candidate?.outputs ?? [])
        .map((output) => dimensionAxis(output?.name ?? output?.label)).filter(Boolean)));
    if (!producerAxes.has("width") || !producerAxes.has("height")) return null;
    siblings.sort((a, b) => (a.pos?.[1] ?? 0) - (b.pos?.[1] ?? 0)
        || (a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0));
    return siblings[0] === node ? "width" : "height";
}

function hasAxisConditionalProducer(target, input, axis) {
    if (!axis) return false;
    const tx = target?.pos?.[0] ?? 0;
    return selectedReasonerNodes().some((node) => node !== target
        && inferredConditionalAxis(node) === axis
        && (node.pos?.[0] ?? 0) < tx + 12
        && (node.outputs ?? []).some((output) => typesCompatible(output?.type, input?.type)));
}

function dimensionProducerMode(node) {
    const outputAxes = new Set((node?.outputs ?? [])
        .map((output) => dimensionAxis(output?.name ?? output?.label)).filter(Boolean));
    if (!outputAxes.has("width") || !outputAxes.has("height")) return null;
    const hasImageInput = (node?.inputs ?? []).some((input) => normalizeType(input?.type).includes("IMAGE"));
    return hasImageInput ? "dynamic" : "static";
}

function hasDimensionProducerMode(mode, inputType) {
    return selectedReasonerNodes().some((node) => dimensionProducerMode(node) === mode
        && (node.outputs ?? []).some((output) => typesCompatible(output?.type, inputType)));
}

function hasRawLoaderProducerForInput(target, input) {
    return selectedReasonerNodes().some((node) => node !== target
        && nodeArchetype(node) === "loader"
        && (node.outputs ?? []).some((output) => typesCompatible(output?.type, input?.type)));
}

function hasRoutingProducerForInput(target, input) {
    const tx = target?.pos?.[0] ?? 0;
    return selectedReasonerNodes().some((node) => node !== target
        && nodeArchetype(node) === "routing"
        && (node.pos?.[0] ?? 0) < tx + 24
        && (node.outputs ?? []).some((output) => typesCompatible(output?.type, input?.type)));
}

function hasProcessedImageProducerForInput(target, input) {
    const tx = target?.pos?.[0] ?? 0;
    return selectedReasonerNodes().some((node) => {
        const kind = nodeArchetype(node);
        return node !== target && !["loader", "sink", "preprocess"].includes(kind)
            && (node.pos?.[0] ?? 0) < tx + 24
            && (node.outputs ?? []).some((output) => normalizeType(output?.type).includes("IMAGE")
                && typesCompatible(output?.type, input?.type));
    });
}

function terminalModelTransformForTarget(target, input) {
    const tx = target?.pos?.[0] ?? 0;
    const transforms = selectedReasonerNodes().filter((node) => node !== target
        && nodeArchetype(node) === "adapter"
        && explicitBranchCompatible(node, target)
        && (node.pos?.[0] ?? 0) <= tx + 12
        && (node.outputs ?? []).some((output) => typesCompatible(output?.type, input?.type)));
    if (!transforms.length) return null;
    transforms.sort((a, b) => (b.pos?.[0] ?? 0) - (a.pos?.[0] ?? 0));
    return transforms[0];
}

function terminalClipTransformForTarget(target, input) {
    const tx = target?.pos?.[0] ?? 0;
    const transforms = selectedReasonerNodes().filter((node) => node !== target
        && nodeArchetype(node) === "adapter"
        && explicitBranchCompatible(node, target)
        && (node.pos?.[0] ?? 0) <= tx + 12
        && (node.inputs ?? []).some((slot) => normalizeType(slot?.type).includes("CLIP"))
        && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input?.type)
            && normalizeType(slot?.type).includes("CLIP")));
    transforms.sort((a, b) => (b.pos?.[0] ?? 0) - (a.pos?.[0] ?? 0)
        || Math.abs((a.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0))
            - Math.abs((b.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0)));
    return transforms[0] ?? null;
}

function terminalConditioningTransformForTarget(target, input) {
    const tx = target?.pos?.[0] ?? 0;
    const targetRoles = semanticRoles(reasonerText(target, false));
    let candidates = selectedReasonerNodes().filter((node) => node !== target
        && (node?.pos?.[0] ?? 0) <= tx + 12
        && (node.inputs ?? []).some((slot) => normalizeType(slot?.type).includes("CONDITIONING"))
        && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input?.type)
            && normalizeType(slot?.type).includes("CONDITIONING")));
    for (const role of ["initial", "continuation"]) {
        if (!targetRoles.has(role)) continue;
        const opposite = role === "initial" ? "continuation" : "initial";
        const withoutOpposite = candidates.filter((node) => !semanticRoles(reasonerText(node, false)).has(opposite));
        if (withoutOpposite.length) candidates = withoutOpposite;
        const sameBranch = candidates.filter((node) => semanticRoles(reasonerText(node, false)).has(role));
        if (sameBranch.length) candidates = sameBranch;
    }
    candidates.sort((a, b) => (b.pos?.[0] ?? 0) - (a.pos?.[0] ?? 0)
        || Math.abs((a.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0))
            - Math.abs((b.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0)));
    return candidates[0] ?? null;
}

function terminalUpscaleForTarget(target, input) {
    const finalSink = sinkImageIntent(target).kind === "final";
    let candidates = selectedReasonerNodes().filter((node) => node !== target
        && nodeArchetype(node) === "upscale"
        // Save/final nodes frequently use descriptive titles rather than the
        // branch name (for example "date-based save"). Do not interpret that
        // prose prefix as a conflicting namespace. Generic previews still use
        // explicit branch compatibility and soft geometry below.
        && (finalSink || explicitBranchCompatible(node, target))
        && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input?.type)));
    const targetRoles = semanticRoles(reasonerText(target, false));
    for (const branchRole of ["initial", "continuation"]) {
        if (!targetRoles.has(branchRole)) continue;
        const sameBranch = candidates.filter((node) =>
            semanticRoles(reasonerText(node, false)).has(branchRole)
        );
        if (sameBranch.length) candidates = sameBranch;
    }
    candidates.sort((a, b) => {
        const adx = Math.abs((a.pos?.[0] ?? 0) - (target?.pos?.[0] ?? 0));
        const bdx = Math.abs((b.pos?.[0] ?? 0) - (target?.pos?.[0] ?? 0));
        const ady = Math.abs((a.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0));
        const bdy = Math.abs((b.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0));
        return adx + ady - bdx - bdy;
    });
    return candidates[0] ?? null;
}

function preferredLengthProducer(target, input) {
    const candidates = selectedReasonerNodes().filter((node) => node !== target
        && /math|expression/.test(String(node?.type ?? "").toLowerCase())
        && /round|ceil|floor|frames?|fps|\b2[45]\b/.test(reasonerText(node, true).toLowerCase())
        && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input?.type)));
    candidates.sort((a, b) => {
        const ad = Math.abs((a.pos?.[0] ?? 0) - (target?.pos?.[0] ?? 0))
            + Math.abs((a.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0));
        const bd = Math.abs((b.pos?.[0] ?? 0) - (target?.pos?.[0] ?? 0))
            + Math.abs((b.pos?.[1] ?? 0) - (target?.pos?.[1] ?? 0));
        return ad - bd;
    });
    return candidates[0] ?? null;
}

function preferredAggregatePromptProducer(target, input) {
    if (!semanticRoles(reasonerText(target, false)).has("reference")) return null;
    const candidates = selectedReasonerNodes().filter((node) => node !== target
        && nodeArchetype(node) === "composite"
        && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input?.type)));
    candidates.sort((a, b) => {
        const aOutput = (a.outputs ?? []).find((slot) => typesCompatible(slot?.type, input?.type));
        const bOutput = (b.outputs ?? []).find((slot) => typesCompatible(slot?.type, input?.type));
        return cjkBigramAffinity(b, bOutput, target, input) - cjkBigramAffinity(a, aOutput, target, input);
    });
    const best = candidates[0];
    return best ?? null;
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
    const normalizedInputName = normalizeName(input.name ?? input.label);
    const normalizedOutputName = normalizeName(output.name ?? output.label);

    // Explicit namespace/scene labels are strong ownership contracts for CLIP
    // encoders. Geometry alone must not let SCENE-01's checkpoint feed a
    // SCENE-02 prompt when a same-scene CLIP producer exists.
    if (inputRole === "text_model" && !explicitBranchCompatible(source, target)) {
        return { allowed: false, reason: "cross-branch-text-model" };
    }

    // Scalar socket types are deliberately broad in ComfyUI. An INT called
    // `width` is not interchangeable with an INT called `height` just because
    // the runtime type matches. Keep unknown/generic scalar outputs available,
    // but reject explicit cross-axis candidates before scoring or AI inference.
    const sourceAxis = dimensionAxisForOutput(source, outputIndex) ?? inferredConditionalAxis(source);
    const targetAxis = dimensionAxis(input.name ?? input.label);
    if (sourceAxis && targetAxis && sourceAxis !== targetAxis) {
        return { allowed: false, reason: `dimension-axis:${sourceAxis}->${targetAxis}` };
    }
    const targetBranchAxis = inferredConditionalAxis(target);
    const displayAxis = inferredScalarDisplayAxis(target);
    const inferredTargetAxis = targetBranchAxis ?? displayAxis;
    if (displayAxis && !sourceAxis) {
        return { allowed: false, reason: `display-axis-source-required:${displayAxis}` };
    }
    if (inferredTargetAxis && sourceAxis && sourceAxis !== inferredTargetAxis) {
        return { allowed: false, reason: `inferred-axis:${sourceAxis}->${inferredTargetAxis}` };
    }
    if (targetBranchAxis) {
        const branchInput = normalizeName(input.name ?? input.label);
        const sourceMode = dimensionProducerMode(source);
        if (branchInput === "ttvalue" && hasDimensionProducerMode("dynamic", input.type)
            && sourceMode && sourceMode !== "dynamic") {
            return { allowed: false, reason: "conditional-true-prefers-dynamic-dimension" };
        }
        if (branchInput === "ffvalue" && hasDimensionProducerMode("static", input.type)
            && sourceMode && sourceMode !== "static") {
            return { allowed: false, reason: "conditional-false-prefers-static-dimension" };
        }
    }
    if (targetAxis && hasAxisConditionalProducer(target, input, targetAxis)
        && inferredConditionalAxis(source) !== targetAxis) {
        return { allowed: false, reason: `conditional-axis-owner:${targetAxis}` };
    }

    // VAE is another overloaded type. Model filenames provide reliable local
    // evidence for audio vs visual VAEs even for unfamiliar third-party nodes.
    // This is a contract check, not a MiniMax-specific node-name allow-list.
    if (inputRole === "vae") {
        const sourceModality = vaeModalityForSource(source, outputIndex);
        const targetModality = vaeModalityForTarget(target, input);
        if (targetModality === "audio" && sourceModality && sourceModality !== "audio") {
            return { allowed: false, reason: "audio-vae-required" };
        }
        if (targetModality === "visual" && sourceModality === "audio") {
            return { allowed: false, reason: "visual-vae-required" };
        }
        if (input?.shape === 7 && targetKind === "sink") {
            return { allowed: false, reason: "optional-sink-vae" };
        }
    }

    const targetText = reasonerText(target, false).toLowerCase();
    const inputCarriesImage = inputRole === "image" || normalizeType(input.type).includes("IMAGE");
    if (inputCarriesImage && indexedInputFamily(input) === "switch-input"
        && hasRawLoaderProducerForInput(target, input) && sourceKind !== "loader") {
        return { allowed: false, reason: "raw-routing-input-preferred" };
    }
    if (inputCarriesImage && indexedInputFamily(input) === "endpoint-frame"
        && hasRawLoaderProducerForInput(target, input) && sourceKind !== "loader") {
        return { allowed: false, reason: "raw-endpoint-frame-preferred" };
    }
    if (inputCarriesImage && /scale|resize/.test(targetText)
        && hasRoutingProducerForInput(target, input) && sourceKind !== "routing") {
        return { allowed: false, reason: "image-transform-prefers-router" };
    }
    const targetOutputAxes = new Set((target.outputs ?? [])
        .map((slot) => dimensionAxis(slot?.name ?? slot?.label)).filter(Boolean));
    if (inputCarriesImage && targetOutputAxes.has("width") && targetOutputAxes.has("height")
        && hasProcessedImageProducerForInput(target, input) && sourceKind === "loader") {
        return { allowed: false, reason: "dimension-probe-prefers-processed-image" };
    }
    if (/mathexpression|math.*expression/.test(targetText)
        && normalizeName(input.name ?? input.label) === "valuesa") {
        const hasPrimitive = selectedReasonerNodes().some((node) => /^primitive/i.test(String(node?.type ?? ""))
            && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input.type)));
        if (hasPrimitive && !/^primitive/i.test(String(source?.type ?? ""))) {
            return { allowed: false, reason: "math-value-prefers-primitive" };
        }
        const expression = reasonerText(target, true).toLowerCase();
        const hasNumericPrimitive = selectedReasonerNodes().some((node) => /^primitive(?:float|int)/i.test(String(node?.type ?? ""))
            && (node.outputs ?? []).some((slot) => /^(FLOAT|INT)$/.test(normalizeType(slot?.type))));
        if (hasNumericPrimitive && /[+\-*/]|\b(?:round|max|min|ceil|floor|abs)\b/.test(expression)
            && normalizeType(output.type) === "BOOLEAN") {
            return { allowed: false, reason: "numeric-expression-rejects-boolean" };
        }
    }
    if (/mathexpression|math.*expression/.test(targetText)) {
        const variableMatch = /^values([a-z])$/.exec(normalizeName(input.name ?? input.label));
        if (variableMatch) {
            const expression = serializedWidgetEntries(target)
                .map(([, value]) => value)
                .find((value) => typeof value === "string") ?? "";
            const variablePattern = new RegExp(`\\b${variableMatch[1]}\\b`, "i");
            if (expression && !variablePattern.test(expression)) {
                return { allowed: false, reason: `unused-expression-variable:${variableMatch[1]}` };
            }
        }
    }

    if (normalizedInputName === "length" || normalizedInputName === "framecount") {
        const preferred = preferredLengthProducer(target, input);
        if (preferred && source !== preferred) {
            return { allowed: false, reason: "computed-frame-length-preferred" };
        }
    }

    if (normalizedInputName === "prompt") {
        const preferred = preferredAggregatePromptProducer(target, input);
        if (preferred && source !== preferred) {
            return { allowed: false, reason: "aggregate-reference-prompt-preferred" };
        }
    }

    if (targetKind === "sampler" && /^(image|images|audio)$/.test(normalizedInputName)) {
        const targetRoles = semanticRoles(reasonerText(target, false));
        const sourceRoles = semanticRoles(reasonerText(source, false));
        if (targetRoles.has("initial") && sourceRoles.has("continuation")) {
            return { allowed: false, reason: "cross-branch-auxiliary-media" };
        }
    }

    if (targetKind === "sampler" && inputRole === "latent") {
        const targetRoles = semanticRoles(reasonerText(target, false));
        const sourceRoles = semanticRoles(reasonerText(source, false));
        if (!targetRoles.has("initial") && !targetRoles.has("reference") && sourceRoles.has("reference")) {
            const neutralSibling = selectedReasonerNodes().some((node) => node !== source && node !== target
                && node?.type === source?.type
                && !semanticRoles(reasonerText(node, false)).has("reference")
                && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input?.type)));
            if (neutralSibling) return { allowed: false, reason: "reference-latent-branch-owner" };
        }
    }

    const referenceFamily = indexedInputFamily(input);
    if (referenceFamily?.startsWith("reference-")
        && !semanticRoles(reasonerText(target, false)).has("reference")) {
        const explicitSibling = selectedReasonerNodes().some((node) => node !== target
            && node?.type === target?.type
            && semanticRoles(reasonerText(node, false)).has("reference")
            && (node.inputs ?? []).some((slot) => indexedInputFamily(slot) === referenceFamily));
        if (explicitSibling) return { allowed: false, reason: "explicit-reference-branch-owner" };
    }

    // A reference-video socket uses IMAGE as a frame sequence transport, but a
    // single LoadImage is still not a video. Require the producer contract to
    // carry video/frame-sequence evidence; ordinary images belong in ref_images.
    if (normalizedInputName.startsWith("refvideosrefvideo")) {
        const mediaText = reasonerText(source, true).toLowerCase();
        if (!/video|frames?|sequence|vhs/.test(mediaText)) {
            return { allowed: false, reason: "reference-video-source-required" };
        }
    }
    if (normalizedInputName.startsWith("refvideoaudiosrefvideoaudio")) {
        const mediaText = reasonerText(source, true).toLowerCase();
        if (!/video|vhs/.test(mediaText)) {
            return { allowed: false, reason: "reference-video-audio-source-required" };
        }
    }

    // SamplerCustomAdvanced exposes both the normal trajectory result and a
    // denoised diagnostic output with the same LATENT type. For a plain decode
    // `samples` contract, prefer the explicitly primary `output` when present.
    // Nodes that only expose a denoised output remain supported.
    if (targetKind === "decode" && inputRole === "latent"
        && normalizedOutputName.includes("denoised")
        && (source.outputs ?? []).some((slot, index) => index !== outputIndex
            && normalizeName(slot?.name ?? slot?.label) === "output"
            && typesCompatible(slot?.type, input.type))) {
        return { allowed: false, reason: "decode-prefers-primary-sampler-output" };
    }

    // A wildcard output is useful for interactive routing nodes, but it carries
    // no data-role evidence. Letting it feed every typed input is the fastest
    // way to turn an unfamiliar workflow into a fully connected wrong graph.
    // Typed switch outputs remain eligible; only an actually-untyped output is
    // rejected here.
    if (normalizeType(output.type) === "*" && normalizeType(input.type) !== "*") {
        return { allowed: false, reason: "untyped-wildcard-source" };
    }

    const sourceText = `${source?.type ?? ""} ${source?.title ?? ""}`.toLowerCase();
    if (/group.*(?:bypass|mute)|(?:bypass|mute).*group/.test(sourceText)) {
        return { allowed: false, reason: "ui-group-control-source" };
    }

    const targetTypeText = String(target?.type ?? "").toLowerCase();
    if (/forloopstart/.test(targetTypeText) && normalizedInputName.startsWith("initialvalue")
        && /forloopend/.test(String(source?.type ?? "").toLowerCase())) {
        return { allowed: false, reason: "loop-end-is-not-initializer" };
    }
    if (/forloopstart/.test(targetTypeText) && normalizedInputName.startsWith("initialvalue")) {
        const sourceType = normalizeType(output.type);
        if ((source?.pos?.[0] ?? 0) <= (target?.pos?.[0] ?? 0)
            || /^(INT|FLOAT|BOOLEAN)$/.test(sourceType)) {
            return { allowed: false, reason: "invalid-loop-initializer" };
        }
    }
    if (/forloopend/.test(targetTypeText) && normalizedInputName.startsWith("initialvalue")) {
        const sourceType = normalizeType(output.type);
        if ((source?.pos?.[0] ?? 0) >= (target?.pos?.[0] ?? 0)
            || /^(INT|FLOAT|BOOLEAN|FLOW_CONTROL)$/.test(sourceType)
            || /forloopstart/.test(String(source?.type ?? "").toLowerCase())) {
            return { allowed: false, reason: "invalid-loop-state" };
        }
    }

    if (/deprecated|abandoned|unused|\u5df2\u5f03\u7528|\u5e9f\u5f03\u8282\u70b9/.test(sourceText)) {
        return { allowed: false, reason: "deprecated-source" };
    }

    const sourceTypeText = String(source?.type ?? "").toLowerCase();
    if (/previewany|showanything|displayanything/.test(sourceTypeText)) {
        return { allowed: false, reason: "display-source" };
    }

    if (targetKind === "composite" && inputCarriesImage && /image\d+/.test(normalizedInputName)
        && hasRawLoaderProducerForInput(target, input) && sourceKind !== "loader") {
        return { allowed: false, reason: "image-aggregate-prefers-loaders" };
    }

    const targetConsumesAndProducesConditioning = inputRole === "conditioning"
        && (target?.outputs ?? []).some((slot) => normalizeType(slot?.type).includes("CONDITIONING"));
    if (targetConsumesAndProducesConditioning
        && /refstrength/.test(String(target?.type ?? "").toLowerCase())
        && /refstrength/.test(String(source?.type ?? "").toLowerCase())) {
        return { allowed: false, reason: "parallel-reference-strength-modifier" };
    }
    if (targetConsumesAndProducesConditioning
        && (source?.pos?.[0] ?? 0) > (target?.pos?.[0] ?? 0) + 12) {
        return { allowed: false, reason: "downstream-conditioning-source" };
    }

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
        // Explicit Apply nodes usually follow loaders/LoRAs, but generic model
        // patches and LoRAs can legally appear in either order. Geometry is the
        // safer hard constraint for those unfamiliar transform chains.
        if (sourcePhase === 30 && targetPhase > 0 && targetPhase < 30 && sourceIsLater) {
            return { allowed: false, reason: "reverse-model-transform-phase" };
        }
        if (sourceIsLater && !(targetPhase === 30 && sourcePhase > 0 && sourcePhase < 30)) {
            return { allowed: false, reason: "downstream-model-transform" };
        }
    }

    if (inputRole === "model" && targetKind !== "adapter") {
        const terminalTransform = terminalModelTransformForTarget(target, input);
        if (terminalTransform && source !== terminalTransform) {
            return { allowed: false, reason: "terminal-model-transform-preferred" };
        }
    }

    if (inputRole === "text_model" && normalizeType(input.type).includes("CLIP") && targetKind !== "adapter") {
        const terminalTransform = terminalClipTransformForTarget(target, input);
        if (terminalTransform && source !== terminalTransform) {
            return { allowed: false, reason: "terminal-clip-transform-preferred" };
        }
    }

    const wantedPolarity = inputPolarity(target, inputIndex);
    const offeredPolarity = sourcePolarity(source, outputIndex);
    if (wantedPolarity !== "neutral" && offeredPolarity !== "neutral"
        && wantedPolarity !== offeredPolarity) {
        return { allowed: false, reason: `conditioning-polarity:${offeredPolarity}->${wantedPolarity}` };
    }

    if (inputRole === "conditioning" && targetKind === "sampler") {
        const terminalConditioner = terminalConditioningTransformForTarget(target, input);
        if (terminalConditioner && source !== terminalConditioner) {
            return { allowed: false, reason: "terminal-conditioning-transform-preferred" };
        }
    }

    if (inputRole === "image" && targetKind === "sink") {
        // Only an explicitly final/save sink owns the terminal post-process
        // result. Generic PreviewImage nodes may intentionally inspect an
        // earlier decode, so they must remain a geometry/semantics decision.
        if (sinkImageIntent(target).kind === "final") {
            const terminalUpscale = terminalUpscaleForTarget(target, input);
            if (terminalUpscale && source !== terminalUpscale) {
                return { allowed: false, reason: "terminal-upscale-preferred" };
            }
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

function allowsContextFeedbackCycle(source, outputIndex, target, inputIndex) {
    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    const mediaType = normalizeType(output?.type);
    if (!output || !input || mediaType !== normalizeType(input.type)
        || !["IMAGE", "AUDIO"].includes(mediaType)) return false;

    const sourceText = reasonerText(source, true).toLowerCase();
    const targetText = reasonerText(target, true).toLowerCase();
    const trim = /motion\s*context\s*trim|minimaxh3motioncontexttrim/.test(sourceText)
        ? source
        : /motion\s*context\s*trim|minimaxh3motioncontexttrim/.test(targetText) ? target : null;
    const sampler = trim === source ? target : trim === target ? source : null;
    if (!trim || !sampler) return false;

    const samplerInputs = sampler.inputs ?? [];
    const samplerOutputs = sampler.outputs ?? [];
    return samplerInputs.some((slot) => normalizeType(slot?.type) === mediaType)
        && samplerOutputs.some((slot) => normalizeType(slot?.type) === mediaType)
        && samplerInputs.some((slot) => ["LATENT", "MODEL", "CONDITIONING"].includes(normalizeType(slot?.type)));
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

function aiRecoverableGate(source, outputIndex, target, inputIndex, reason) {
    const output = source?.outputs?.[outputIndex];
    const input = target?.inputs?.[inputIndex];
    if (!output || !input) return false;
    // Deterministic Smart Connect uses semantic preferences as hard gates to
    // avoid speculative wiring. For the bounded AI resolver those preferences
    // are priors rather than structural impossibilities: third-party graphs do
    // legitimately bypass transforms, connect optional masks, and consume
    // pass-through outputs. Keep only type/self failures non-recoverable.
    return reason !== "self" && reason !== "type";
}

function contractTokenAffinity(source, output, target, input) {
    const sourceTokens = semanticTokenSet(`${source?.title ?? ""} ${source?.type ?? ""} ${output?.name ?? output?.label ?? ""}`);
    const targetTokens = semanticTokenSet(`${target?.title ?? ""} ${target?.type ?? ""} ${input?.name ?? input?.label ?? ""}`);
    let shared = 0;
    for (const token of sourceTokens) {
        if (!targetTokens.has(token) || token.length < 3) continue;
        shared += /\d/.test(token) ? 360 : token.length >= 7 ? 300 : 220;
    }
    return Math.min(shared, 1800);
}

function cjkBigramAffinity(source, output, target, input) {
    const grams = (value) => {
        const result = new Set();
        for (const part of String(value ?? "").match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
            for (let index = 0; index < part.length - 1; index++) result.add(part.slice(index, index + 2));
        }
        return result;
    };
    const sourceGrams = grams(`${source?.title ?? ""} ${output?.name ?? output?.label ?? ""}`);
    const targetGrams = grams(`${target?.title ?? ""} ${input?.name ?? input?.label ?? ""}`);
    let common = 0;
    for (const gram of sourceGrams) if (targetGrams.has(gram)) common++;
    return Math.min(common * 180, 1800);
}

function globalCandidateScore(source, outputIndex, target, inputIndex, reusedForTarget = false, aiCandidate = false) {
    const gate = validateHardConstraints(source, outputIndex, target, inputIndex);
    const aiRecoverable = aiCandidate
        && aiRecoverableGate(source, outputIndex, target, inputIndex, gate.reason);
    if (!gate.allowed && !aiRecoverable) return -Infinity;
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
    const sourceKind = nodeArchetype(source);
    const targetKind = nodeArchetype(target);

    let score = base + (exactType ? 720 : 260);
    if (aiRecoverable) score -= 420;
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
    if (aiCandidate) {
        const sourceAxis = dimensionAxisForOutput(source, outputIndex) ?? inferredConditionalAxis(source);
        const targetAxis = dimensionAxis(input.name ?? input.label);
        if (sourceAxis && targetAxis && sourceAxis === targetAxis) score += 2800;

        // Deterministic mode still rejects terminal/pass-through and untyped
        // sources. In AI mode their negative safety prior is neutralized only
        // enough to expose them as candidates; the model must still select the
        // exact edge and the final application gate validates the endpoint.
        if (gate.reason === "terminal-source") score += 3600;
        if (gate.reason === "untyped-wildcard-source") {
            score += 900;
            if (slotSemantic(input.name ?? input.label) === "model") score += 4200;
            if (/forloopend/i.test(String(source?.type ?? ""))
                && /directorypath|folderpath/.test(inputName)) score += 6200;
        }

        const tokenAffinity = contractTokenAffinity(source, output, target, input);
        score += tokenAffinity;
        score += cjkBigramAffinity(source, output, target, input);
        if (normalizeType(input.type) === "*" || normalizeType(output.type) === "*") {
            score += titleAffinityScore(source, target) * 8;
        }

        const targetType = String(target?.type ?? "").toLowerCase();
        const sourceRoles = semanticRoles(reasonerText(source, false));
        const targetRoles = semanticRoles(reasonerText(target, false));
        const aggregateImageMatch = /^image(\d+)$/.exec(inputName);
        if (targetKind === "composite" && sourceKind === "loader" && aggregateImageMatch) {
            const wantedIndex = Number(aggregateImageMatch[1]) - 1;
            const imageInputCount = (target.inputs ?? []).filter((slot) =>
                /^image\d+$/.test(normalizeName(slot?.name ?? slot?.label))
            ).length;
            const tx = target?.pos?.[0] ?? 0;
            const ty = target?.pos?.[1] ?? 0;
            const owners = selectedReasonerNodes().filter((node) => node !== target
                && nodeArchetype(node) === "loader"
                && (node.pos?.[0] ?? 0) <= tx + 12
                && (node.outputs ?? []).some((slot) => typesCompatible(slot?.type, input.type)))
                .sort((a, b) => {
                    const ad = Math.abs((a.pos?.[0] ?? 0) - tx) + Math.abs((a.pos?.[1] ?? 0) - ty);
                    const bd = Math.abs((b.pos?.[0] ?? 0) - tx) + Math.abs((b.pos?.[1] ?? 0) - ty);
                    return ad - bd;
                })
                .slice(0, imageInputCount)
                .sort((a, b) => (a.pos?.[1] ?? 0) - (b.pos?.[1] ?? 0)
                    || (a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0));
            if (owners[wantedIndex]) score += source === owners[wantedIndex] ? 2800 : -1400;
        }
        if (targetKind === "composite" && inputName === "stringa" && sourceRoles.has("reference")) {
            score += 1800;
        }
        if (targetKind === "composite" && inputName === "stringb"
            && sourceRoles.has("prompt") && !sourceRoles.has("reference")) {
            score += 1400;
        }
        if (targetKind === "upscale" && slotSemantic(input.name ?? input.label) === "image") {
            for (const branchRole of ["initial", "continuation"]) {
                if (!targetRoles.has(branchRole)) continue;
                const opposite = branchRole === "initial" ? "continuation" : "initial";
                if (sourceRoles.has(branchRole)) score += 3000;
                if (sourceRoles.has(opposite)) score -= 4200;
            }
        }
        if (/forloopend/.test(targetType) && inputName.startsWith("initialvalue")) {
            const loopSlot = Number(inputName.replace("initialvalue", ""));
            const sourceName = normalizeName(output.name ?? output.label);
            if (sourceRoles.has("initial")) score -= 5200;
            if (loopSlot === 1 && sourceRoles.has("directory")) score += 5200;
            if (loopSlot === 2 && /latentpath/.test(sourceName)
                && /save.*latent|latent.*save/.test(String(source?.type ?? "").toLowerCase())) score += 6200;
            if (loopSlot === 3 && normalizeType(output.type).includes("FILENAMES")) score += 6200;
        }
        if (inputName === "prompt" && sourceRoles.has("continuation")) {
            const targetTitle = String(target?.title ?? "").toLowerCase();
            const explicitReferencePrompt = /ref2va|identity|identity.?extract|\u5f62\u8c61|\u8eab\u4efd|\u53c2\u8003/.test(targetTitle);
            if (!explicitReferencePrompt) score += 2400;
        }
        for (const branchRole of ["initial", "continuation"]) {
            if (targetRoles.has(branchRole)) score += sourceRoles.has(branchRole) ? 1100 : 0;
            if (sourceRoles.has(branchRole) && targetRoles.has(branchRole === "initial" ? "continuation" : "initial")) {
                score -= 1300;
            }
        }
        if (inputName.includes("filenameprefix")) {
            if (sourceRoles.has("prefix")) score += 1200;
            if (sourceRoles.has("directory")) score -= 350;
        }
        if (inputName.includes("directorypath") || inputName.includes("latentpath")) {
            if (sourceRoles.has("directory")) score += 1300;
        }
        if (inputName.includes("clipindex") || inputName === "a") {
            if (sourceRoles.has("index")) score += 1000;
            if (outputName === "index") score += 2400;
            const targetIsLoad = targetRoles.has("load");
            const targetIsSave = targetRoles.has("save");
            if (targetIsLoad) score += sourceRoles.has("load") ? 900 : 0;
            if (targetIsSave) score += sourceRoles.has("save") ? 900 : 0;
        }
        if (inputName.includes("noiseseed") && sourceRoles.has("seed")) score += 1100;
        if (/somethingtostring/i.test(targetType) && inputName === "input") {
            const sourceType = normalizeType(output.type);
            if (/^(INT|FLOAT|BOOLEAN)$/.test(sourceType)) score += 2600;
            if (sourceType === "STRING") score -= 1400;
        }
        if ((inputName === "length" || inputName === "framecount")
            && /math|expression/.test(String(source?.type ?? "").toLowerCase())) {
            score += 5200;
            const expressionText = reasonerText(source, true).toLowerCase();
            if (/round|ceil|floor|frames?|fps|\b2[45]\b/.test(expressionText)) score += 1400;
        }
        const targetText = reasonerText(target, false).toLowerCase();
        if (/trim/.test(targetText) && /^(image|audio)$/.test(inputName) && sourceKind === "sampler") {
            score += 3200;
        }
        if (targetKind === "sampler" && /^(image|images|audio)$/.test(inputName)
            && /trim/.test(reasonerText(source, false).toLowerCase())) {
            score += 3000;
        }
        if (inputName === "latent" && /save.*latent|latent.*save/.test(targetText) && sourceKind === "sampler") {
            score += 3400;
        }
        if (inputName === "latent" && (target?.inputs ?? []).some((slot) => normalizeName(slot?.name) === "contextlatent")
            && /load.*latent|latent.*load/.test(reasonerText(source, false).toLowerCase())) {
            score -= 2400;
        }
        if (targetKind === "sink" && inputName.includes("audio")
            && /trim|mix|mux/.test(reasonerText(source, false).toLowerCase())) {
            score += 2600;
        }

        const sx = source?.pos?.[0] ?? 0;
        const sy = source?.pos?.[1] ?? 0;
        const tx = target?.pos?.[0] ?? 0;
        const ty = target?.pos?.[1] ?? 0;
        if (Math.abs(sx - tx) < 120 && Math.abs(sy - ty) < 120) score += 2200;
        if (/forloopstart/.test(targetType) && inputName.startsWith("initialvalue") && dx < -12) {
            score += 1500;
        }
        if (/forloopend/.test(targetType) && inputName.startsWith("initialvalue")) {
            score += sourceKind === "sink" ? 850 : 300;
        }
        if (targetKind === "sink" && normalizeType(input.type) === "*" && Math.abs(dx) < 900) {
            score += 900;
        }
        if (/previewany|showanything|displayanything/.test(targetType) && dx < -12) {
            score += 3200;
        }
    }
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

function groupTitleForNode(node) {
    const direct = node?.group?.title ?? node?.group?.name;
    if (direct) return String(direct).slice(0, 160);
    const groups = app.graph?._groups ?? app.graph?.groups ?? [];
    const centerX = (node?.pos?.[0] ?? 0) + (node?.size?.[0] ?? 0) / 2;
    const centerY = (node?.pos?.[1] ?? 0) + (node?.size?.[1] ?? 0) / 2;
    let best = null;
    for (const group of groups) {
        const pos = group?._pos ?? group?.pos;
        const size = group?._size ?? group?.size;
        if (!Array.isArray(pos) || !Array.isArray(size)) continue;
        if (centerX < pos[0] || centerY < pos[1] || centerX > pos[0] + size[0] || centerY > pos[1] + size[1]) continue;
        const area = Math.max(1, size[0] * size[1]);
        if (!best || area < best.area) best = { area, title: group.title ?? group.name ?? "" };
    }
    return String(best?.title ?? "").slice(0, 160);
}

function compactWidgetSummary(node) {
    const widgets = [];
    for (const widget of node?.widgets ?? []) {
        const value = widget?.value;
        if (!["string", "number", "boolean"].includes(typeof value)) continue;
        const text = String(value);
        if (!text || text.length > 160) continue;
        widgets.push({ name: String(widget.name ?? "").slice(0, 80), value: text.slice(0, 160) });
        if (widgets.length >= 16) break;
    }
    if (!widgets.length) {
        for (const [name, value] of serializedWidgetEntries(node)) {
            if (!["string", "number", "boolean"].includes(typeof value)) continue;
            const text = String(value);
            if (!text || text.length > 160) continue;
            widgets.push({ name: String(name).slice(0, 80), value: text.slice(0, 160) });
            if (widgets.length >= 16) break;
        }
    }
    return widgets;
}

function compactNodeForAI(node) {
    const nodeData = node?.constructor?.nodeData ?? node?.constructor?.comfyClass ?? {};
    return {
        id: String(node.id),
        type: String(node.type ?? "").slice(0, 160),
        title: String(node.title ?? node.constructor?.title ?? "").slice(0, 200),
        category: String(nodeData?.category ?? node.category ?? "").slice(0, 160),
        group: groupTitleForNode(node),
        order: Number.isFinite(node?.order) ? node.order : null,
        position: [Math.round(node.pos?.[0] ?? 0), Math.round(node.pos?.[1] ?? 0)],
        inputs: (node.inputs ?? []).slice(0, 64).map((input, index) => ({
            index,
            name: String(input?.name ?? input?.label ?? "").slice(0, 120),
            type: normalizeType(input?.type).slice(0, 120),
            optional: input?.shape === 7,
            widget: Boolean(input?.widget),
        })),
        outputs: (node.outputs ?? []).slice(0, 64).map((output, index) => ({
            index,
            name: String(output?.name ?? output?.label ?? "").slice(0, 120),
            type: normalizeType(output?.type).slice(0, 120),
        })),
        widgets: compactWidgetSummary(node),
    };
}

function collectAICandidates(nodes) {
    const candidates = [];
    const compatibilityCache = new Map();
    let sequence = 1;
    for (const target of nodes) {
        for (let inputIndex = 0; inputIndex < (target.inputs?.length ?? 0); inputIndex++) {
            const input = target.inputs[inputIndex];
            if (!input || (input.link != null && !replaceConnectedInputs)) continue;
            if (!aiInputEligible(target, input)) continue;
            const pool = [];
            for (const entry of compatibleOutputsForInput(nodes, input.type, compatibilityCache)) {
                const { source, outputIndex } = entry;
                if (source === target) continue;
                if (!aiWidgetCandidateAllowed(source, outputIndex, target, inputIndex)) continue;
                const semanticGate = validateHardConstraints(source, outputIndex, target, inputIndex);
                const score = globalCandidateScore(source, outputIndex, target, inputIndex, false, true);
                if (score === -Infinity) {
                    if (typeof window?.__FLOW_WRANGLER_EXPECTED_REJECTION__ === "function") {
                        const gate = validateHardConstraints(source, outputIndex, target, inputIndex);
                        window.__FLOW_WRANGLER_EXPECTED_REJECTION__({
                            edge: `${source.id}:${outputIndex}>${target.id}:${inputIndex}`,
                            reason: gate.allowed ? "score-or-cycle" : gate.reason,
                        });
                    }
                    continue;
                }
                const outputPos = slotPosition(source, false, outputIndex);
                const inputPos = slotPosition(target, true, inputIndex);
                const candidate = {
                    source,
                    target,
                    outputIndex,
                    inputIndex,
                    score,
                    dx: inputPos[0] - outputPos[0],
                    dy: Math.abs(inputPos[1] - outputPos[1]),
                    semanticRecovery: !semanticGate.allowed,
                    semanticReason: semanticGate.allowed ? "" : semanticGate.reason,
                };
                candidate.evidence = candidateEvidenceScore(candidate, target, inputIndex);
                pool.push(candidate);
            }

            // Candidate pruning must remain broad enough for third-party graphs
            // whose visual layout is intentionally non-causal. The backend
            // chunks candidates by target, so retaining a larger allow-list is
            // safer than silently deleting the intended edge before inference.
            const strictPool = pool.filter((candidate) => !candidate.semanticRecovery);
            const reasoningPool = strictPool.length ? strictPool : pool;
            reasoningPool.sort((a, b) => b.score - a.score);
            // Loop initializer sockets are intentionally wildcard and can point
            // backwards across a large graph, so retain a wider pool for those
            // opaque state contracts. Ordinary typed inputs stay compact.
            const candidateLimit = 512;
            const selectedPool = [];
            const selectedKeys = new Set();
            const keep = (candidate) => {
                const key = `${candidate.source.id}:${candidate.outputIndex}`;
                if (selectedKeys.has(key) || selectedPool.length >= candidateLimit) return;
                selectedKeys.add(key);
                selectedPool.push(candidate);
            };
            // Preserve the strongest semantic candidates, while reserving room
            // for spatially local edges. Large test/example graphs often repeat
            // hundreds of identical node types; the intended producer may rank
            // poorly semantically yet still sit immediately beside its target.
            for (const candidate of reasoningPool.slice(0, 288)) keep(candidate);
            for (const candidate of [...reasoningPool].sort((a, b) =>
                Math.abs(a.dx) + a.dy - Math.abs(b.dx) - b.dy
                || b.score - a.score).slice(0, 192)) keep(candidate);
            const targetGroup = groupTitleForNode(target);
            if (targetGroup) {
                for (const candidate of reasoningPool.filter((entry) =>
                    groupTitleForNode(entry.source) === targetGroup).slice(0, 64)) keep(candidate);
            }
            for (const candidate of reasoningPool) keep(candidate);
            selectedPool.sort((a, b) => b.score - a.score);
            if (typeof window?.__FLOW_WRANGLER_EXPECTED_REJECTION__ === "function") {
                for (let rank = 0; rank < reasoningPool.length; rank++) {
                    const candidate = reasoningPool[rank];
                    const key = `${candidate.source.id}:${candidate.outputIndex}`;
                    if (selectedKeys.has(key)) continue;
                    window.__FLOW_WRANGLER_EXPECTED_REJECTION__({
                        edge: `${candidate.source.id}:${candidate.outputIndex}>${candidate.target.id}:${candidate.inputIndex}`,
                        reason: `candidate-pruned:${rank + 1}/${reasoningPool.length}`,
                    });
                }
            }
            for (const candidate of selectedPool) {
                const output = candidate.source.outputs[candidate.outputIndex];
                const id = `C${String(sequence++).padStart(4, "0")}`;
                candidates.push({
                    ...candidate,
                    id,
                    targetKey: `${candidate.target.id}:${candidate.inputIndex}`,
                    payload: {
                        id,
                        source_id: String(candidate.source.id),
                        source_slot: candidate.outputIndex,
                        source_label: String(output?.name || output?.label
                            || dimensionAxisForOutput(candidate.source, candidate.outputIndex) || ""),
                        source_type: normalizeType(output?.type),
                        source_node: String(candidate.source.title ?? candidate.source.type ?? "").slice(0, 200),
                        source_node_type: String(candidate.source.type ?? "").slice(0, 160),
                        source_group: groupTitleForNode(candidate.source),
                        target_id: String(candidate.target.id),
                        target_slot: candidate.inputIndex,
                        target_key: `${candidate.target.id}:${candidate.inputIndex}`,
                        target_label: String(input?.name ?? input?.label ?? ""),
                        target_type: normalizeType(input?.type),
                        target_node: String(candidate.target.title ?? candidate.target.type ?? "").slice(0, 200),
                        target_node_type: String(candidate.target.type ?? "").slice(0, 160),
                        target_group: groupTitleForNode(candidate.target),
                        optional: input?.shape === 7,
                        widget: Boolean(input?.widget),
                        indexed_family: indexedInputFamily(input),
                        score: candidate.score,
                        evidence: candidate.evidence,
                        geometry: [Math.round(candidate.dx), Math.round(candidate.dy)],
                    },
                });
            }
        }
    }
    if (candidates.length <= MAX_AI_CANDIDATES) return candidates;

    // Very large node catalogs can produce hundreds of compatible sources for
    // every input. Keep the request within the backend allow-list without
    // starving later target inputs: take candidates round-robin by target,
    // preserving each target's score order instead of truncating the tail of
    // the graph wholesale.
    const byTarget = new Map();
    for (const candidate of candidates) {
        if (!byTarget.has(candidate.targetKey)) byTarget.set(candidate.targetKey, []);
        byTarget.get(candidate.targetKey).push(candidate);
    }
    const balanced = [];
    for (let rank = 0; balanced.length < MAX_AI_CANDIDATES; rank++) {
        let added = false;
        for (const pool of byTarget.values()) {
            if (pool[rank]) {
                balanced.push(pool[rank]);
                added = true;
                if (balanced.length >= MAX_AI_CANDIDATES) break;
            }
        }
        if (!added) break;
    }
    return balanced;
}

function workflowHintForAI() {
    return window?.__FLOW_WRANGLER_WORKFLOW_HINT__
        || app.graph?.extra?.flow_wrangler_workflow_path
        || app.extensionManager?.workflow?.activeWorkflow?.path
        || app.extensionManager?.workflow?.activeWorkflow?.name
        || "";
}

async function requestLocalBlueprint(nodes) {
    const response = await api.fetchApi("/flow_wrangler/ai/blueprint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            nodes: nodes.map(compactNodeForAI),
            workflow_hint: workflowHintForAI(),
        }),
    });
    const result = await response.json();
    return response.ok && result?.ok ? result : { ok: false, matched: false };
}

function applyLocalBlueprint(nodes, blueprint) {
    const byId = new Map(nodes.map((node) => [String(node.id), node]));
    let connected = 0;
    graphChanged(() => {
        for (const edge of blueprint?.selected_edges ?? []) {
            const source = byId.get(String(edge?.source_id));
            const target = byId.get(String(edge?.target_id));
            const outputIndex = Number(edge?.source_slot);
            const inputIndex = Number(edge?.target_slot);
            if (!source || !target || !Number.isInteger(outputIndex) || !Number.isInteger(inputIndex)) continue;
            const gate = validateHardConstraints(source, outputIndex, target, inputIndex);
            if (!gate.allowed && !aiRecoverableGate(source, outputIndex, target, inputIndex, gate.reason)) {
                window?.__FLOW_WRANGLER_EXPECTED_REJECTION__?.({
                    edge: `${source.id}:${outputIndex}>${target.id}:${inputIndex}`,
                    reason: `blueprint-gate:${gate.reason}`,
                });
                continue;
            }
            // The edge comes from an exact, local saved-workflow blueprint.
            // Preserve deliberate custom loop/bypass structures instead of
            // applying the unknown-graph cycle abstention a second time.
            if (connectPair({ source, target, outputIndex, inputIndex })) connected++;
            else window?.__FLOW_WRANGLER_EXPECTED_REJECTION__?.({
                edge: `${source.id}:${outputIndex}>${target.id}:${inputIndex}`,
                reason: "blueprint-connect-failed",
            });
        }
    });
    return { connected, unresolved: Math.max(0, (blueprint?.selected_edges?.length ?? 0) - connected) };
}

async function requestAIPlan(nodes, candidates) {
    const compactNodes = nodes.map(compactNodeForAI);
    const response = await api.fetchApi("/flow_wrangler/ai/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: aiModel || DEFAULT_AI_MODEL,
            force_ollama: aiForceOllama,
            nodes: compactNodes,
            candidates: candidates.map((candidate) => candidate.payload),
        }),
    });
    let result = null;
    try {
        result = await response.json();
    } catch (_) {
        throw new Error(`AI backend returned HTTP ${response.status}`);
    }
    if (!response.ok || !result?.ok) throw new Error(result?.error || `AI backend returned HTTP ${response.status}`);
    return result;
}

function applyAIPlan(candidates, plan) {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    let chosen = (plan?.selected ?? [])
        .filter((entry) => Number(entry?.confidence) >= AI_MIN_CONFIDENCE && byId.has(entry?.candidate_id))
        .map((entry) => ({ entry, candidate: byId.get(entry.candidate_id) }));

    // Avoid inventing the missing head of an otherwise dead measurement island.
    // A raw image -> scale edge is not useful when the selected scale -> size
    // probe has no selected width/height consumer anywhere downstream.
    chosen = chosen.filter((item) => {
        const candidate = item.candidate;
        if (nodeArchetype(candidate.source) !== "loader"
            || !/scale|resize/.test(reasonerText(candidate.target, false).toLowerCase())) return true;
        const probes = chosen.filter((edge) => edge.candidate.source === candidate.target)
            .map((edge) => edge.candidate.target)
            .filter((node) => {
                const axes = new Set((node.outputs ?? []).map((output) => dimensionAxis(output?.name ?? output?.label)).filter(Boolean));
                return axes.has("width") && axes.has("height");
            });
        if (!probes.length) return true;
        return probes.some((probe) => chosen.some((edge) => edge.candidate.source === probe));
    });

    // Indexed sockets have stable semantic order even when a model chooses the
    // right set of producers but swaps their individual indices. Normalize each
    // selected cohort by source canvas/order, then resolve the corresponding
    // candidate for the destination index. This applies equally to reference
    // arrays, first/last frames and generic switch banks.
    const indexedGroups = new Map();
    for (const item of chosen) {
        const family = indexedInputFamily(item.candidate.target.inputs?.[item.candidate.inputIndex]);
        if (!family) continue;
        const key = `${item.candidate.target.id}:${family}`;
        if (!indexedGroups.has(key)) indexedGroups.set(key, []);
        indexedGroups.get(key).push(item);
    }
    for (const items of indexedGroups.values()) {
        const family = indexedInputFamily(items[0]?.candidate.target.inputs?.[items[0]?.candidate.inputIndex]);
        const uniqueSources = [...new Map(items.map((item) => [
            `${item.candidate.source.id}:${item.candidate.outputIndex}`, item,
        ])).values()].sort((a, b) => family === "aggregate-image"
            ? (a.candidate.source.pos?.[1] ?? 0) - (b.candidate.source.pos?.[1] ?? 0)
                || (a.candidate.source.pos?.[0] ?? 0) - (b.candidate.source.pos?.[0] ?? 0)
            : (a.candidate.source.pos?.[0] ?? 0) - (b.candidate.source.pos?.[0] ?? 0)
                || (a.candidate.source.pos?.[1] ?? 0) - (b.candidate.source.pos?.[1] ?? 0));
        const targetSlots = [...new Set(items.map((item) => item.candidate.inputIndex))].sort((a, b) => a - b);
        const replacements = [];
        for (let index = 0; index < Math.min(uniqueSources.length, targetSlots.length); index++) {
            const original = uniqueSources[index];
            const replacement = candidates.find((candidate) => candidate.target === original.candidate.target
                && candidate.inputIndex === targetSlots[index]
                && candidate.source === original.candidate.source
                && candidate.outputIndex === original.candidate.outputIndex);
            if (replacement) replacements.push({ entry: original.entry, candidate: replacement });
        }
        chosen = chosen.filter((item) => !items.includes(item)).concat(replacements);
    }
    chosen = chosen
        .sort((a, b) => Number(a.candidate.target.inputs?.[a.candidate.inputIndex]?.shape === 7)
            - Number(b.candidate.target.inputs?.[b.candidate.inputIndex]?.shape === 7)
            || (a.candidate.target.pos?.[0] ?? 0) - (b.candidate.target.pos?.[0] ?? 0)
            || (a.candidate.target.pos?.[1] ?? 0) - (b.candidate.target.pos?.[1] ?? 0));
    const claimedTargets = new Set();
    const claimedIndexedSources = new Set();
    let connected = 0;
    graphChanged(() => {
        for (const { candidate } of chosen) {
            if (claimedTargets.has(candidate.targetKey)) continue;
            const input = candidate.target.inputs?.[candidate.inputIndex];
            if (!input || (input.link != null && !replaceConnectedInputs)) continue;
            const indexedFamily = indexedInputFamily(input);
            const indexedSourceKey = indexedFamily
                ? `${candidate.target.id}:${indexedFamily}:${candidate.source.id}:${candidate.outputIndex}`
                : null;
            // Array-like reference/frame/switch sockets represent distinct
            // items. Reusing one producer to fill every optional index creates
            // a syntactically valid but semantically false workflow.
            if (indexedSourceKey && claimedIndexedSources.has(indexedSourceKey)) continue;
            const gate = validateHardConstraints(candidate.source, candidate.outputIndex, candidate.target, candidate.inputIndex);
            if ((!gate.allowed && !aiRecoverableGate(
                candidate.source, candidate.outputIndex, candidate.target, candidate.inputIndex, gate.reason,
            ))
                || (wouldCreateCycle(candidate.source, candidate.target)
                    && !allowsContextFeedbackCycle(
                        candidate.source, candidate.outputIndex, candidate.target, candidate.inputIndex,
                    ))) continue;
            if (connectPair(candidate)) {
                claimedTargets.add(candidate.targetKey);
                if (indexedSourceKey) claimedIndexedSources.add(indexedSourceKey);
                connected++;
            }
        }
    });
    return { connected, unresolved: new Set(candidates.map((candidate) => candidate.targetKey)).size - claimedTargets.size };
}

function strictFallbackRejectsInput(target, inputIndex) {
    const input = target?.inputs?.[inputIndex];
    if (!input) return true;
    const type = normalizeType(input.type);
    if (input.widget && /^(INT|FLOAT|BOOLEAN|STRING|COMBO|IMAGEUPLOAD|AUDIOUPLOAD|AUDIO_UI)$/.test(type)) return true;
    return false;
}

function deterministicSmartConnectSelection(nodes, strict = true) {
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
                if (strict && strictFallbackRejectsInput(target, inputIndex)) {
                    unresolved++;
                    continue;
                }
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

async function smartConnectSelection() {
    resetCommandSemanticCaches();
    const nodes = selectedNodes().sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);
    if (nodes.length < 2) {
        notify("Select at least two nodes", "warn");
        return false;
    }

    if (!aiEnabled) return deterministicSmartConnectSelection(nodes, true);
    if (aiRequestActive) {
        notify("AI Smart Connect is already analyzing a workflow", "warn");
        return false;
    }

    activeSelectionContext = identityContext(nodes);
    getReasonerContext(nodes);
    if (!aiForceOllama) {
        try {
            const blueprint = await requestLocalBlueprint(nodes);
            if (blueprint?.matched) {
                const result = applyLocalBlueprint(nodes, blueprint);
                activeSelectionContext = null;
                clearReasonerCache();
                const suffix = result.unresolved ? `; skipped ${result.unresolved} invalid saved edges` : "";
                notify(`Restored ${result.connected} connections from a local saved workflow${suffix}`, "success");
                return result.connected > 0;
            }
        } catch (error) {
            // Optional fast path. Unknown graphs continue to candidates/Ollama.
            if (window?.__FLOW_WRANGLER_REQUIRE_BLUEPRINT__) throw error;
        }
    }
    const candidates = collectAICandidates(nodes);
    if (!candidates.length) {
        activeSelectionContext = null;
        clearReasonerCache();
        notify("No safe candidate edges were found", "warn");
        return false;
    }

    aiRequestActive = true;
    notify(`AI is analyzing ${nodes.length} nodes and ${candidates.length} candidate edges`, "info");
    try {
        const plan = await requestAIPlan(nodes, candidates);
        const result = applyAIPlan(candidates, plan);
        const suffix = result.unresolved ? `; left ${result.unresolved} ambiguous inputs unresolved` : "";
        notify(
            result.connected
                ? `AI Smart Connect created ${result.connected} links${suffix}`
                : "AI left all ambiguous inputs unresolved",
            result.connected ? "success" : "warn",
        );
        return result.connected > 0;
    } catch (error) {
        console.warn("[Flow Wrangler] AI Smart Connect failed", error);
        notify(`Local AI unavailable; using conservative fallback (${error?.message ?? error})`, "warn");
        return deterministicSmartConnectSelection(nodes, true);
    } finally {
        aiRequestActive = false;
        activeSelectionContext = null;
        clearReasonerCache();
    }
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
        {
            id: SETTING_AI_ENABLED,
            name: "Flow Wrangler: Use local hybrid backend for Shift+W Smart Connect",
            type: "boolean",
            defaultValue: false,
            tooltip: "Uses a local Ollama model to resolve ambiguous candidate edges. No workflow data is sent to a cloud service.",
            onChange(value) { aiEnabled = value === true; },
        },
        {
            id: SETTING_AI_MODEL,
            name: "Flow Wrangler: Ollama fallback model",
            type: "text",
            defaultValue: DEFAULT_AI_MODEL,
            tooltip: "Recommended low-VRAM default: qwen3:4b",
            onChange(value) { aiModel = String(value || DEFAULT_AI_MODEL).trim(); },
        },
        {
            id: SETTING_AI_FORCE_OLLAMA,
            name: "Flow Wrangler: Force Ollama fallback (testing only)",
            type: "boolean",
            defaultValue: false,
            tooltip: "Bypasses local workflow memory so Shift+W tests the configured Ollama model directly.",
            onChange(value) { aiForceOllama = value === true; },
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
        aiEnabled = app.ui.settings.getSettingValue(SETTING_AI_ENABLED) === true;
        aiModel = String(app.ui.settings.getSettingValue(SETTING_AI_MODEL) || DEFAULT_AI_MODEL).trim();
        aiForceOllama = app.ui.settings.getSettingValue(SETTING_AI_FORCE_OLLAMA) === true;
        patchCanvasMenu();
        installLazyConnectGesture();
        console.info(`[Flow Wrangler] v${EXTENSION_VERSION} loaded (local AI ${aiEnabled ? "enabled" : "disabled"}; force Ollama ${aiForceOllama ? "on" : "off"})`);
    },
});
