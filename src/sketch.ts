import p5 from "p5";
import { PLAYER_1, SYSTEM } from "@rcade/plugin-input-classic";
import {
    PLAYER_1 as SPINNER_P1,
    PLAYER_2 as SPINNER_P2,
} from "@rcade/plugin-input-spinners";

// Rcade game dimensions
const WIDTH = 336;
const HEIGHT = 262;

// Gradient/image area
const GRAD_W = 320;
const GRAD_H = 200;
const GRAD_X = Math.floor((WIDTH - GRAD_W) / 2);
const GRAD_Y = Math.floor((HEIGHT - GRAD_H) / 2);

// Spinner sensitivity (pixels per step)
const SPINNER_SPEED = 2;

// --- Seeded PRNG for Daily mode ---
// Simple mulberry32: deterministic from a 32-bit seed

function mulberry32(seed: number): () => number {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function dateSeed(): number {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// --- Color distance metrics ---
// Difficulty determines which metric is used to score accuracy.
//
// EASY: Weighted RGB
//   Applies perceptual weights (humans see green > red > blue) to Euclidean
//   RGB distance. Forgiving — colors that "look close enough" score well,
//   even if individual channels are somewhat off.
//
// MEDIUM: Euclidean RGB
//   Straight-line distance in RGB space: sqrt((r1-r2)² + (g1-g2)² + (b1-b2)²).
//   Mathematically simple but perceptually uneven — equal numeric differences
//   in blue matter less to human eyes than green, so this can feel "unfair."
//
// HARD: CIE76 (CIELAB Delta E)
//   Converts both colors to CIELAB color space (designed to be perceptually
//   uniform) then computes Euclidean distance. A Delta E of ~2.3 is the
//   "just noticeable difference." Most accurate to human perception — you
//   really have to nail the color.

type Difficulty = "easy" | "medium" | "hard";

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
    easy: "Easy",
    medium: "Medium",
    hard: "Hard",
};

const DIFFICULTY_DESCRIPTIONS: Record<Difficulty, string> = {
    easy: "Weighted RGB",
    medium: "Euclidean RGB",
    hard: "CIE76 Lab",
};

function distEuclideanRgb(
    r1: number, g1: number, b1: number,
    r2: number, g2: number, b2: number
): number {
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function distWeightedRgb(
    r1: number, g1: number, b1: number,
    r2: number, g2: number, b2: number
): number {
    return Math.sqrt(2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2);
}

function distCIE76(
    r1: number, g1: number, b1: number,
    r2: number, g2: number, b2: number
): number {
    const [l1, a1, b1_] = rgbToLab(r1, g1, b1);
    const [l2, a2, b2_] = rgbToLab(r2, g2, b2);
    return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1_ - b2_) ** 2);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
    let rl = r / 255, gl = g / 255, bl = b / 255;
    rl = rl > 0.04045 ? ((rl + 0.055) / 1.055) ** 2.4 : rl / 12.92;
    gl = gl > 0.04045 ? ((gl + 0.055) / 1.055) ** 2.4 : gl / 12.92;
    bl = bl > 0.04045 ? ((bl + 0.055) / 1.055) ** 2.4 : bl / 12.92;

    const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
    const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750);
    const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;

    const f = (t: number) => t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116;
    const fx = f(x), fy = f(y), fz = f(z);

    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function computeAccuracy(
    difficulty: Difficulty,
    r1: number, g1: number, b1: number,
    r2: number, g2: number, b2: number
): number {
    let dist: number;
    let maxDist: number;

    switch (difficulty) {
        case "easy":
            dist = distWeightedRgb(r1, g1, b1, r2, g2, b2);
            maxDist = distWeightedRgb(0, 0, 0, 255, 255, 255);
            break;
        case "medium":
            dist = distEuclideanRgb(r1, g1, b1, r2, g2, b2);
            maxDist = distEuclideanRgb(0, 0, 0, 255, 255, 255);
            break;
        case "hard":
            dist = distCIE76(r1, g1, b1, r2, g2, b2);
            maxDist = distCIE76(0, 0, 0, 255, 255, 255);
            break;
    }

    // Scale maxDist down so only truly close matches score well.
    // The full black-to-white diagonal is way too generous — picking
    // the center of any gradient would score ~80% for most targets.
    // A power curve further penalises "kinda close" picks.
    const scale = difficulty === "easy" ? 0.55
                : difficulty === "medium" ? 0.45
                : 0.35;
    const power = difficulty === "easy" ? 1.5
                : difficulty === "medium" ? 2.0
                : 2.5;

    const ratio = Math.min(1, dist / (maxDist * scale));
    return Math.max(0, 100 * Math.pow(1 - ratio, power));
}

// --- Gradient modes ---

type GradientMode = {
    name: string;
    label: string;
    colorAt: (nx: number, ny: number) => [number, number, number];
};

const GRADIENT_MODES: GradientMode[] = [
    {
        name: "HSB",
        label: "Hue -> Brightness",
        colorAt: (nx, ny) => hsbToRgb(nx * 360, 100, 100 - ny * 100),
    },
    {
        name: "HSB Sat",
        label: "Hue -> Saturation",
        colorAt: (nx, ny) => hsbToRgb(nx * 360, 100 - ny * 100, 100),
    },
    {
        name: "RGB: RG",
        label: "Red -> Green",
        colorAt: (nx, ny) => [
            Math.round(nx * 255),
            Math.round((1 - ny) * 255),
            0,
        ],
    },
    {
        name: "RGB: RB",
        label: "Red -> Blue",
        colorAt: (nx, ny) => [
            Math.round(nx * 255),
            0,
            Math.round((1 - ny) * 255),
        ],
    },
    {
        name: "RGB: GB",
        label: "Green -> Blue",
        colorAt: (nx, ny) => [
            0,
            Math.round(nx * 255),
            Math.round((1 - ny) * 255),
        ],
    },
    {
        name: "CMY",
        label: "Cyan -> Magenta",
        colorAt: (nx, ny) => [
            Math.round((1 - nx) * 255),
            Math.round((1 - ny) * 255),
            255,
        ],
    },
    {
        name: "Warm",
        label: "Yellow -> Red",
        colorAt: (nx, ny) => hsbToRgb(60 - nx * 60, 100, 100 - ny * 70),
    },
    {
        name: "Cool",
        label: "Cyan -> Purple",
        colorAt: (nx, ny) => hsbToRgb(180 + nx * 120, 100, 100 - ny * 70),
    },
    {
        name: "Grayscale",
        label: "Gray -> Gray",
        colorAt: (nx, ny) => {
            const base = Math.round(nx * 255);
            const tint = (ny - 0.5) * 30;
            return [
                Math.round(Math.min(255, Math.max(0, base + tint))),
                base,
                Math.round(Math.min(255, Math.max(0, base - tint))),
            ];
        },
    },
];

// --- Bundled photo library ---
// Pre-resized to GRAD_W x GRAD_H, served from public/photos/

const PHOTO_LIBRARY: { file: string; title: string; artist: string }[] = [
    { file: "andromeda_galaxy.jpg", title: "Andromeda Galaxy", artist: "NASA" },
    { file: "birth_of_venus.jpg", title: "The Birth of Venus", artist: "Sandro Botticelli" },
    { file: "blue_marble.jpg", title: "The Blue Marble", artist: "NASA / Apollo 17" },
    { file: "cafe_terrace.jpg", title: "Café Terrace at Night", artist: "Vincent van Gogh" },
    { file: "crab_nebula.jpg", title: "Crab Nebula", artist: "NASA / Hubble" },
    { file: "earthrise.jpg", title: "Earthrise", artist: "NASA / Apollo 8" },
    { file: "girl_with_pearl_earring.jpg", title: "Girl with a Pearl Earring", artist: "Johannes Vermeer" },
    { file: "great_wave.jpg", title: "The Great Wave off Kanagawa", artist: "Katsushika Hokusai" },
    { file: "impression_sunrise.jpg", title: "Impression, Sunrise", artist: "Claude Monet" },
    { file: "milkmaid.jpg", title: "The Milkmaid", artist: "Johannes Vermeer" },
    { file: "mona_lisa.jpg", title: "Mona Lisa", artist: "Leonardo da Vinci" },
    { file: "pale_blue_dot.jpg", title: "Pale Blue Dot", artist: "NASA / Voyager 1" },
    { file: "pillars_of_creation.jpg", title: "Pillars of Creation", artist: "NASA / Hubble" },
    { file: "saturn.jpg", title: "Saturn during Equinox", artist: "NASA / Cassini" },
    { file: "starry_night.jpg", title: "The Starry Night", artist: "Vincent van Gogh" },
    { file: "sunday_grande_jatte.jpg", title: "A Sunday on La Grande Jatte", artist: "Georges Seurat" },
    { file: "the_scream.jpg", title: "The Scream", artist: "Edvard Munch" },
];

type PhotoImageData = {
    img: HTMLImageElement;
    title: string;
    artist: string;
    pixels: Uint8ClampedArray;
    w: number;
    h: number;
    dominantColors: [number, number, number][];
};

// Cache: map of filename -> PhotoImageData
const photoCache: Map<string, PhotoImageData> = new Map();
let photoFetchError: string | null = null;

async function loadBundledPhoto(entry: typeof PHOTO_LIBRARY[number]): Promise<PhotoImageData> {
    const cached = photoCache.get(entry.file);
    if (cached) return cached;

    const pixelData = await loadImagePixels(`photos/${entry.file}`);
    const dominantColors = kMeansDominantColors(pixelData.pixels, pixelData.w, pixelData.h, 5);

    const result: PhotoImageData = {
        img: pixelData.img,
        title: entry.title,
        artist: entry.artist,
        pixels: pixelData.pixels,
        w: pixelData.w,
        h: pixelData.h,
        dominantColors,
    };

    photoCache.set(entry.file, result);
    return result;
}

// --- K-Means color clustering ---
// Extracts the N most dominant colors from an image's pixel data.
// Downsamples to ~4000 pixels for performance, runs 15 iterations of k-means,
// then sorts clusters by size (most common first).

function kMeansDominantColors(
    pixels: Uint8ClampedArray,
    w: number,
    h: number,
    k: number
): [number, number, number][] {
    // Downsample: grab every Nth pixel to get ~4000 samples
    const totalPixels = w * h;
    const step = Math.max(1, Math.floor(totalPixels / 4000));
    const samples: [number, number, number][] = [];

    for (let i = 0; i < totalPixels; i += step) {
        const idx = i * 4;
        const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
        // Skip near-black pixels (often from letterboxing/borders)
        if (r + g + b > 30) {
            samples.push([r, g, b]);
        }
    }

    if (samples.length < k) {
        // Fallback: not enough non-black pixels
        const fallback: [number, number, number][] = [];
        for (let i = 0; i < k; i++) {
            fallback.push([128, 128, 128]);
        }
        return fallback;
    }

    // Initialize centroids by picking evenly spaced samples (k-means++ lite)
    const centroids: [number, number, number][] = [];
    for (let i = 0; i < k; i++) {
        centroids.push([...samples[Math.floor((i / k) * samples.length)]]);
    }

    // Assignment array
    const assignments = new Int32Array(samples.length);

    // Run k-means for 15 iterations
    for (let iter = 0; iter < 15; iter++) {
        // Assign each sample to the nearest centroid
        for (let i = 0; i < samples.length; i++) {
            let bestDist = Infinity;
            let bestK = 0;
            for (let j = 0; j < k; j++) {
                const dr = samples[i][0] - centroids[j][0];
                const dg = samples[i][1] - centroids[j][1];
                const db = samples[i][2] - centroids[j][2];
                const dist = dr * dr + dg * dg + db * db;
                if (dist < bestDist) {
                    bestDist = dist;
                    bestK = j;
                }
            }
            assignments[i] = bestK;
        }

        // Recompute centroids
        const sums = new Float64Array(k * 3);
        const counts = new Int32Array(k);
        for (let i = 0; i < samples.length; i++) {
            const c = assignments[i];
            sums[c * 3] += samples[i][0];
            sums[c * 3 + 1] += samples[i][1];
            sums[c * 3 + 2] += samples[i][2];
            counts[c]++;
        }
        for (let j = 0; j < k; j++) {
            if (counts[j] > 0) {
                centroids[j][0] = sums[j * 3] / counts[j];
                centroids[j][1] = sums[j * 3 + 1] / counts[j];
                centroids[j][2] = sums[j * 3 + 2] / counts[j];
            }
        }
    }

    // Count final cluster sizes for sorting
    const finalCounts = new Int32Array(k);
    for (let i = 0; i < samples.length; i++) {
        finalCounts[assignments[i]]++;
    }

    // Sort by cluster size (most dominant first) and round to integers
    const indexed = centroids.map((c, i) => ({ color: c, count: finalCounts[i] }));
    indexed.sort((a, b) => b.count - a.count);

    return indexed.map(({ color }) => [
        Math.round(color[0]),
        Math.round(color[1]),
        Math.round(color[2]),
    ]);
}

function loadImagePixels(
    url: string
): Promise<{
    img: HTMLImageElement;
    pixels: Uint8ClampedArray;
    w: number;
    h: number;
}> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = GRAD_W;
            canvas.height = GRAD_H;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0, GRAD_W, GRAD_H);

            const imageData = ctx.getImageData(0, 0, GRAD_W, GRAD_H);
            resolve({
                img,
                pixels: imageData.data,
                w: GRAD_W,
                h: GRAD_H,
            });
        };
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = url;
    });
}

/** Sample a color from photo image pixel data at (x, y) */
function samplePhotoPixel(
    photo: PhotoImageData,
    x: number,
    y: number
): [number, number, number] {
    const cx = Math.max(0, Math.min(photo.w - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(photo.h - 1, Math.round(y)));
    const idx = (cy * photo.w + cx) * 4;
    return [photo.pixels[idx], photo.pixels[idx + 1], photo.pixels[idx + 2]];
}


// --- Game types ---

type GameMode = "daily" | "anxiety" | "photo";

type GameState =
    | "title"
    | "mode_select"
    | "difficulty"
    | "loading_photo"
    | "memorize"
    | "search"
    | "round_reveal"
    | "round_result"
    | "final_result"
    | "enter_initials"
    | "high_scores";

type RoundResult = {
    target: [number, number, number];
    pickedPos: [number, number]; // cursor position when locked in
    picked: [number, number, number];
    accuracy: number;
};

// --- Color theory tips ---
// Shown during the memorize phase to teach players about color.

const COLOR_TIPS = [
    "Cyan is the absence of red",
    "RGB: how screens make color",
    "CMY: how printers make color",
    "Hue is measured in degrees",
    "Saturation = color intensity",
    "Brightness = light amount",
    "Complementary colors are\n180 degrees apart on the wheel",
    "Human eyes are most\nsensitive to green light",
    "A delta-E of 2.3 is the\nsmallest visible difference",
    "Magenta doesn't exist\nin the light spectrum",
    "White light contains\nall visible wavelengths",
    "Red has the longest\nwavelength we can see",
    "Your monitor has 16.7\nmillion possible colors",
    "CIELAB was designed to\nmatch human perception",
    "Yellow = red + green light",
    "Screens mix light (additive)\nPaint mixes pigment (subtractive)",
];

/** Convert RGB to hex string */
function rgbToHex(r: number, g: number, b: number): string {
    return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

// --- High score system ---

type HighScoreEntry = {
    initials: string;
    score: number; // average accuracy
    date: string;  // ISO date string
};

const MAX_HIGH_SCORES = 10;

function highScoreKey(mode: GameMode, diff: Difficulty): string {
    return `colorMatcher_hs_${mode}_${diff}`;
}

function loadHighScores(mode: GameMode, diff: Difficulty): HighScoreEntry[] {
    try {
        const raw = localStorage.getItem(highScoreKey(mode, diff));
        if (!raw) return [];
        return JSON.parse(raw) as HighScoreEntry[];
    } catch {
        return [];
    }
}

function saveHighScores(mode: GameMode, diff: Difficulty, scores: HighScoreEntry[]) {
    localStorage.setItem(highScoreKey(mode, diff), JSON.stringify(scores));
}

function qualifiesForHighScore(mode: GameMode, diff: Difficulty, score: number): boolean {
    const scores = loadHighScores(mode, diff);
    if (scores.length < MAX_HIGH_SCORES) return true;
    return score > scores[scores.length - 1].score;
}

function insertHighScore(mode: GameMode, diff: Difficulty, entry: HighScoreEntry): HighScoreEntry[] {
    const scores = loadHighScores(mode, diff);
    scores.push(entry);
    scores.sort((a, b) => b.score - a.score);
    const trimmed = scores.slice(0, MAX_HIGH_SCORES);
    saveHighScores(mode, diff, trimmed);
    return trimmed;
}

// --- Random color generation ---

function randomTargetColorSeeded(rng: () => number): [number, number, number] {
    const hue = rng() * 360;
    const sat = rng() * 70 + 30;
    const bri = rng() * 60 + 30;
    return hsbToRgb(hue, sat, bri);
}

function randomTargetColor(p: p5): [number, number, number] {
    const hue = p.random(0, 360);
    const sat = p.random(30, 100);
    const bri = p.random(30, 90);
    return hsbToRgb(hue, sat, bri);
}

// --- Main sketch ---

const sketch = (p: p5) => {
    let arcadeFont: p5.Font;
    let state: GameState = "title";
    let gameMode: GameMode = "daily";
    let modeIndex = 0;
    const gameModes: GameMode[] = ["daily", "anxiety", "photo"];
    const MODE_LABELS: Record<GameMode, string> = {
        daily: "Daily Colors",
        anxiety: "Anxiety Mode",
        photo: "Photo of the Day",
    };
    const MODE_DESCRIPTIONS: Record<GameMode, string[]> = {
        daily: ["Same 5 colors for", "everyone today"],
        anxiety: ["Endless! Time shrinks! Ahh!", "Accuracy under 50% = game over"],
        photo: ["Find colors from the", "Wikimedia photo of the day"],
    };

    let difficulty: Difficulty = "medium";
    let difficultyIndex = 1;
    const difficulties: Difficulty[] = ["easy", "medium", "hard"];

    // Negative mode — shows RGB complement during memorize
    let negativeMode = false;

    // Transition animation state
    let transition: {
        type: "dissolve" | "fade";
        startTime: number;
        duration: number;
        fromSnapshot?: p5.Image;
    } | null = null;


    // --- Movement-driven melody system ---
    // Notes are MIDI numbers; converted to Hz via 440 * 2^((n-69)/12)
    function midiToHz(n: number): number {
        return 440 * Math.pow(2, (n - 69) / 12);
    }

    // 5 famous public-domain melodies as MIDI note sequences
    const MELODIES: { name: string; notes: number[] }[] = [
        {
            name: "Ode to Joy",
            //        E  E  F  G  G  F  E  D  C  C  D  E  E  D  D
            notes: [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62,
                    64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60],
        },
        {
            name: "Frere Jacques",
            //        C  D  E  C  C  D  E  C  E  F  G  E  F  G
            notes: [60, 62, 64, 60, 60, 62, 64, 60, 64, 65, 67, 64, 65, 67,
                    67, 69, 67, 65, 64, 60, 67, 69, 67, 65, 64, 60,
                    60, 55, 60, 60, 55, 60],
        },
        {
            name: "Greensleeves",
            //        A  C  D  E  F  E  D  B  G  A  B  C  A  A  G# A  B  G#  E
            notes: [57, 60, 62, 64, 65, 64, 62, 59, 55, 57, 59, 60, 57, 57,
                    56, 57, 59, 56, 52, 57, 60, 62, 64, 65, 64, 62, 59, 55,
                    57, 59, 60, 59, 57, 56, 55, 56, 57],
        },
        {
            name: "House of the Rising Sun",
            //  Am      C        D        F        Am       C        E        E
            //  A  C  E   C  E  G   D  F  A   C  F  A   A  C  E   C  E  G   E  G# B  E  G# B
            notes: [57, 60, 64, 60, 64, 67, 62, 65, 69, 60, 65, 69,
                    57, 60, 64, 60, 64, 67, 64, 68, 71, 64, 68, 71,
                    57, 60, 64, 60, 64, 67, 62, 65, 69, 60, 65, 69,
                    57, 60, 64, 64, 68, 71, 64, 60, 57],
        },
        {
            name: "Singin' in the Rain",
            //  G  G  G  G  A  G  E     G  G  G  A  G     E  G  A  B  B  A  G  A  G  E  D
            notes: [67, 67, 67, 67, 69, 67, 64, 67, 67, 67, 69, 67,
                    64, 67, 69, 71, 71, 69, 67, 69, 67, 64, 62,
                    64, 64, 64, 64, 65, 64, 62, 64, 64, 64, 65, 64,
                    62, 64, 65, 67, 67, 65, 64, 65, 64, 62, 60],
        },
        {
            name: "Scarborough Fair",
            //  D  D  A  A  E  F  E  D     C  D  E  G  A     A  G  A  E  D  C  D
            notes: [62, 62, 69, 69, 64, 65, 64, 62,
                    60, 62, 64, 67, 69,
                    69, 67, 69, 64, 62, 60, 62,
                    62, 62, 69, 69, 64, 65, 64, 62,
                    60, 62, 64, 67, 69, 67, 69, 64, 62],
        },
        {
            name: "Also Sprach Zarathustra",
            //  The iconic sunrise fanfare: C  G  C'  (+ E  C#')
            notes: [48, 55, 60,
                    64, 61,
                    48, 55, 60,
                    64, 63,
                    48, 55, 60,
                    64, 67, 72,
                    67, 64, 60, 55, 48],
        },
        {
            name: "Daisy Bell",
            //  G  E  C  E  C  A  G     G  A  B  C'  B  A  G  A  G  E  D
            notes: [67, 64, 60, 64, 60, 57, 55, 55, 57, 59, 60, 59, 57,
                    55, 57, 55, 52, 50,
                    60, 62, 64, 65, 64, 62, 60, 62, 64, 60, 57, 55,
                    55, 57, 59, 60, 64, 62, 60],
        },
        {
            name: "Maple Leaf Rag",
            //  Syncopated opening theme (simplified single voice)
            //  Ab  Bb  A  Bb  C'  E  C'  A    Ab  Bb  A  Bb  C'  E'  Db'  C'
            notes: [68, 70, 69, 70, 72, 76, 72, 69,
                    68, 70, 69, 70, 72, 76, 73, 72,
                    68, 70, 69, 70, 72, 76, 72, 69,
                    70, 69, 65, 64, 60, 64, 65, 69],
        },
        {
            name: "Chasing Rainbows",
            //  Chopin Fantaisie-Impromptu melody adapted
            //  C# D# E  F# E  D# C#  B  A  B  C#  D#  E  D#  C#  B
            notes: [61, 63, 64, 66, 64, 63, 61, 59, 57, 59, 61, 63,
                    64, 63, 61, 59,
                    61, 63, 64, 66, 68, 66, 64, 63, 61, 63, 64, 66,
                    68, 71, 68, 66, 64, 63, 61],
        },
    ];

    // Melody playback state
    let melodyIndex = 0;
    let melodyNoteIndex = 0;
    let melodyMovementAccum = 0;
    const MELODY_MOVEMENT_THRESHOLD = 6; // pixels of movement per note

    function playMelodyNote(midiNote: number) {
        const ctx = ensureSfxCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain).connect(ctx.destination);
        const t = ctx.currentTime;

        osc.type = "triangle";
        osc.frequency.setValueAtTime(midiToHz(midiNote), t);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.setValueAtTime(0.12, t + 0.08);
        gain.gain.linearRampToValueAtTime(0, t + 0.25);
        osc.start(t);
        osc.stop(t + 0.25);
    }

    // Menu SFX — lightweight sound effects using a shared AudioContext
    let sfxCtx: AudioContext | null = null;

    function ensureSfxCtx(): AudioContext {
        if (!sfxCtx) sfxCtx = new AudioContext();
        if (sfxCtx.state === "suspended") sfxCtx.resume();
        return sfxCtx;
    }

    function playSfx(type: "navigate" | "select" | "toggle" | "lockin") {
        const ctx = ensureSfxCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain).connect(ctx.destination);
        const t = ctx.currentTime;

        switch (type) {
            case "navigate": {
                // Short high tick
                osc.type = "square";
                osc.frequency.setValueAtTime(880, t);
                osc.frequency.setValueAtTime(660, t + 0.03);
                gain.gain.setValueAtTime(0.08, t);
                gain.gain.linearRampToValueAtTime(0, t + 0.06);
                osc.start(t);
                osc.stop(t + 0.06);
                break;
            }
            case "select": {
                // Rising two-tone confirm
                osc.type = "square";
                osc.frequency.setValueAtTime(440, t);
                osc.frequency.setValueAtTime(660, t + 0.06);
                osc.frequency.setValueAtTime(880, t + 0.12);
                gain.gain.setValueAtTime(0.1, t);
                gain.gain.linearRampToValueAtTime(0, t + 0.2);
                osc.start(t);
                osc.stop(t + 0.2);
                break;
            }
            case "toggle": {
                // Quick blip
                osc.type = "sine";
                osc.frequency.setValueAtTime(600, t);
                osc.frequency.setValueAtTime(800, t + 0.04);
                gain.gain.setValueAtTime(0.1, t);
                gain.gain.linearRampToValueAtTime(0, t + 0.08);
                osc.start(t);
                osc.stop(t + 0.08);
                break;
            }
            case "lockin": {
                // Satisfying descending thunk
                osc.type = "triangle";
                osc.frequency.setValueAtTime(500, t);
                osc.frequency.exponentialRampToValueAtTime(200, t + 0.15);
                gain.gain.setValueAtTime(0.15, t);
                gain.gain.linearRampToValueAtTime(0, t + 0.2);
                osc.start(t);
                osc.stop(t + 0.2);
                break;
            }
        }
    }

    /** Schedule a short note on the SFX context */
    function scheduleNote(
        ctx: AudioContext,
        freq: number,
        startTime: number,
        duration: number,
        volume: number,
        type: OscillatorType = "triangle"
    ) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain).connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(volume, startTime);
        gain.gain.setValueAtTime(volume, startTime + duration * 0.7);
        gain.gain.linearRampToValueAtTime(0, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration);
    }

    function playResultJingle(accuracy: number) {
        const ctx = ensureSfxCtx();
        const t = ctx.currentTime;

        if (accuracy >= 98) {
            // PERFECT — triumphant sparkle fanfare
            // C major arpeggio up two octaves + shimmery top
            const notes = [523, 659, 784, 1047, 1319, 1568, 2093];
            for (let i = 0; i < notes.length; i++) {
                scheduleNote(ctx, notes[i], t + i * 0.07, 0.4, 0.1, "sine");
            }
            // Sparkle shimmer on top
            scheduleNote(ctx, 2637, t + 0.5, 0.6, 0.06, "sine");
            scheduleNote(ctx, 3136, t + 0.6, 0.5, 0.05, "sine");
            scheduleNote(ctx, 2093, t + 0.7, 0.8, 0.08, "sine");
        } else if (accuracy >= 90) {
            // 90-97%: Bright major chord fanfare
            // C-E-G-C ascending
            scheduleNote(ctx, 523, t, 0.35, 0.1, "triangle");
            scheduleNote(ctx, 659, t + 0.1, 0.3, 0.1, "triangle");
            scheduleNote(ctx, 784, t + 0.2, 0.3, 0.1, "triangle");
            scheduleNote(ctx, 1047, t + 0.3, 0.5, 0.12, "triangle");
        } else if (accuracy >= 80) {
            // 80-89%: Happy rising third
            scheduleNote(ctx, 440, t, 0.2, 0.1, "triangle");
            scheduleNote(ctx, 554, t + 0.12, 0.2, 0.1, "triangle");
            scheduleNote(ctx, 659, t + 0.24, 0.4, 0.1, "triangle");
        } else if (accuracy >= 70) {
            // 70-79%: Gentle major two-note
            scheduleNote(ctx, 392, t, 0.25, 0.1, "triangle");
            scheduleNote(ctx, 523, t + 0.15, 0.35, 0.1, "triangle");
        } else if (accuracy >= 60) {
            // 60-69%: Neutral single note with slight rise
            scheduleNote(ctx, 349, t, 0.2, 0.08, "sine");
            scheduleNote(ctx, 392, t + 0.15, 0.3, 0.08, "sine");
        } else if (accuracy >= 50) {
            // 50-59%: Flat, uncertain tone
            scheduleNote(ctx, 330, t, 0.3, 0.08, "sine");
            scheduleNote(ctx, 311, t + 0.2, 0.3, 0.07, "sine");
        } else if (accuracy >= 40) {
            // 40-49%: Descending minor second — slightly off
            scheduleNote(ctx, 330, t, 0.25, 0.08, "square");
            scheduleNote(ctx, 311, t + 0.15, 0.25, 0.07, "square");
            scheduleNote(ctx, 294, t + 0.3, 0.3, 0.06, "square");
        } else if (accuracy >= 30) {
            // 30-39%: Sad descending minor
            scheduleNote(ctx, 294, t, 0.25, 0.08, "square");
            scheduleNote(ctx, 262, t + 0.18, 0.25, 0.07, "square");
            scheduleNote(ctx, 247, t + 0.36, 0.35, 0.06, "square");
        } else if (accuracy >= 20) {
            // 20-29%: Low descending buzz
            scheduleNote(ctx, 220, t, 0.2, 0.08, "sawtooth");
            scheduleNote(ctx, 196, t + 0.15, 0.2, 0.07, "sawtooth");
            scheduleNote(ctx, 165, t + 0.3, 0.35, 0.06, "sawtooth");
        } else if (accuracy >= 10) {
            // 10-19%: Womp womp
            scheduleNote(ctx, 196, t, 0.3, 0.1, "sawtooth");
            scheduleNote(ctx, 131, t + 0.3, 0.5, 0.08, "sawtooth");
        } else {
            // 0-9%: Sad trombone slide
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain).connect(ctx.destination);
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(250, t);
            osc.frequency.exponentialRampToValueAtTime(80, t + 0.8);
            gain.gain.setValueAtTime(0.1, t);
            gain.gain.setValueAtTime(0.1, t + 0.5);
            gain.gain.linearRampToValueAtTime(0, t + 0.8);
            osc.start(t);
            osc.stop(t + 0.8);
        }
    }

    // Round state
    let round = 0;
    let targetColor: [number, number, number] = [0, 0, 0];
    let phaseStartTime = 0;
    let results: RoundResult[] = [];
    let tipIndex = 0;
    let finalScrollOffset = 0; // which result index is at the top of the visible window

    // High score / initials entry state
    let initialsChars: number[] = [0, 0, 0]; // index into ALPHABET for each position
    let initialsPos = 0; // which of the 3 letters we're editing (0-2)
    let currentHighScores: HighScoreEntry[] = [];
    let highScoreScrollOffset = 0;
    let playerFinalScore = 0; // cached average accuracy for the just-finished game
    let hsComboIndex = 0; // index into mode×difficulty combos for browsing
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let dailyRng: (() => number) | null = null;
    let dailyColors: [number, number, number][] = [];

    // Photo mode state — one image per round
    let photoRounds: {
        photo: PhotoImageData;
        p5img: p5.Image;
        targetColor: [number, number, number];
    }[] = [];
    let photoRng: (() => number) | null = null;

    // Gradient / cursor state
    let cursorX = GRAD_W / 2;
    let cursorY = GRAD_H / 2;
    let gradModeIndex = 0;
    let gradientImg: p5.Image;
    let prevA = false;
    let prevB = false;
    let prevStart = false;
    let prevUp = false;
    let prevDown = false;
    // Spinner menu navigation: accumulate delta, trigger at threshold
    let spinnerMenuAccum = 0;
    const SPINNER_MENU_THRESHOLD = 3;

    function renderGradient() {
        const mode = GRADIENT_MODES[gradModeIndex];
        gradientImg.loadPixels();
        for (let y = 0; y < GRAD_H; y++) {
            for (let x = 0; x < GRAD_W; x++) {
                const nx = x / (GRAD_W - 1);
                const ny = y / (GRAD_H - 1);
                const [r, g, b] = mode.colorAt(nx, ny);
                const idx = (y * GRAD_W + x) * 4;
                gradientImg.pixels[idx] = r;
                gradientImg.pixels[idx + 1] = g;
                gradientImg.pixels[idx + 2] = b;
                gradientImg.pixels[idx + 3] = 255;
            }
        }
        gradientImg.updatePixels();
    }

    function captureFrame(): p5.Image {
        const img = p.createImage(WIDTH, HEIGHT);
        img.copy(p as any, 0, 0, WIDTH, HEIGHT, 0, 0, WIDTH, HEIGHT);
        return img;
    }

    // Simple hash for dissolve block thresholds
    function blockHash(x: number, y: number): number {
        let h = x * 374761393 + y * 668265263;
        h = (h ^ (h >> 13)) * 1274126177;
        return ((h ^ (h >> 16)) >>> 0) / 4294967296;
    }

    function drawDissolveOverlay(snapshot: p5.Image, progress: number) {
        // The new state is already drawn underneath.
        // Draw only the blocks of the snapshot that haven't dissolved yet.
        const blockSize = 8;
        snapshot.loadPixels();
        p.noStroke();
        for (let by = 0; by < HEIGHT; by += blockSize) {
            for (let bx = 0; bx < WIDTH; bx += blockSize) {
                const threshold = blockHash(bx / blockSize, by / blockSize);
                if (progress <= threshold) {
                    // This block is still visible — sample its color and draw a rect
                    const idx = (by * WIDTH + bx) * 4;
                    p.fill(
                        snapshot.pixels[idx],
                        snapshot.pixels[idx + 1],
                        snapshot.pixels[idx + 2]
                    );
                    const w = Math.min(blockSize, WIDTH - bx);
                    const h = Math.min(blockSize, HEIGHT - by);
                    p.rect(bx, by, w, h);
                }
            }
        }
    }

    function getMemorizeTime(): number {
        switch (gameMode) {
            case "daily":
                return 5;
            case "anxiety":
                // Starts at 5s, decreases by 0.5s per round, min 1s
                return Math.max(1, 5 - round * 0.5);
            case "photo":
                return 5;
        }
    }

    function getSearchTime(): number {
        switch (gameMode) {
            case "daily":
                return 10;
            case "anxiety":
                return 10;
            case "photo":
                return 20;
        }
    }

    function getTotalRoundsLabel(): string {
        switch (gameMode) {
            case "daily":
                return "5";
            case "anxiety":
                return "???";
            case "photo":
                return "5";
        }
    }

    function startGame() {
        round = 0;
        results = [];

        if (gameMode === "daily") {
            dailyRng = mulberry32(dateSeed());
            dailyColors = [];
            for (let i = 0; i < 5; i++) {
                dailyColors.push(randomTargetColorSeeded(dailyRng));
            }
        }

        if (gameMode === "photo") {
            state = "loading_photo";
            photoRounds = [];
            photoFetchError = null;
            // Shuffle the photo library and pick 5
            photoRng = mulberry32(dateSeed() + Math.floor(Math.random() * 10000));
            const shuffled = [...PHOTO_LIBRARY];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(photoRng() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            const picks = shuffled.slice(0, 5);
            // Load all 5 images in parallel
            Promise.all(picks.map((entry) => loadBundledPhoto(entry)))
                .then((photos) => {
                    for (const photo of photos) {
                        const img = p.createImage(GRAD_W, GRAD_H);
                        img.loadPixels();
                        for (let i = 0; i < photo.pixels.length; i++) {
                            img.pixels[i] = photo.pixels[i];
                        }
                        img.updatePixels();
                        photoRounds.push({
                            photo,
                            p5img: img,
                            targetColor: photo.dominantColors[0],
                        });
                    }
                    startRound();
                })
                .catch((e) => {
                    photoFetchError = (e as Error).message;
                });
            return;
        }

        startRound();
    }

    function startRound() {
        cursorX = GRAD_W / 2;
        cursorY = GRAD_H / 2;
        gradModeIndex = 0;
        renderGradient();

        // Pick a melody for this round
        melodyIndex = (melodyIndex + 1) % MELODIES.length;
        melodyNoteIndex = 0;
        melodyMovementAccum = 0;

        switch (gameMode) {
            case "daily":
                targetColor = dailyColors[round];
                break;
            case "anxiety":
                targetColor = randomTargetColor(p);
                break;
            case "photo":
                targetColor = photoRounds[round].targetColor;
                break;
        }

        tipIndex = Math.floor(p.random(COLOR_TIPS.length));
        state = "memorize";
        phaseStartTime = p.millis();
    }

    function edgePressed(current: boolean, prev: boolean): boolean {
        return current && !prev;
    }

    function isGameOver(): boolean {
        switch (gameMode) {
            case "daily":
                return round >= 5;
            case "anxiety": {
                // Game over if last round was < 50%
                if (results.length === 0) return false;
                return results[results.length - 1].accuracy < 50;
            }
            case "photo":
                return round >= 5;
        }
    }

    p.preload = () => {
        arcadeFont = p.loadFont("/fonts/ARCADE_N.TTF");
    };

    p.setup = () => {
        p.createCanvas(WIDTH, HEIGHT);
        p.textFont(arcadeFont);
        gradientImg = p.createImage(GRAD_W, GRAD_H);
        renderGradient();
    };

    p.draw = () => {
        const now = p.millis();
        const aDown = PLAYER_1.A;
        const bDown = PLAYER_1.B;
        const startDown = SYSTEM.ONE_PLAYER;
        const upDown = PLAYER_1.DPAD.up;
        const downDown = PLAYER_1.DPAD.down;
        const aPressed = edgePressed(aDown, prevA);
        const bPressed = edgePressed(bDown, prevB);
        const startPressed = edgePressed(startDown, prevStart);
        const upPressed = edgePressed(upDown, prevUp);
        const downPressed = edgePressed(downDown, prevDown);

        // Always consume spinner deltas to avoid accumulation
        const dx = SPINNER_P1.SPINNER.consume_step_delta();
        const dy = SPINNER_P2.SPINNER.consume_step_delta();

        // Spinner-based menu navigation: either spinner can navigate
        let menuUp = upPressed;
        let menuDown = downPressed;
        const spinnerDelta = dx + dy;
        if (spinnerDelta !== 0) {
            spinnerMenuAccum += spinnerDelta;
            if (spinnerMenuAccum >= SPINNER_MENU_THRESHOLD) {
                menuDown = true;
                spinnerMenuAccum = 0;
            } else if (spinnerMenuAccum <= -SPINNER_MENU_THRESHOLD) {
                menuUp = true;
                spinnerMenuAccum = 0;
            }
        }

        switch (state) {
            case "title":
                drawTitle();
                if (startPressed) {
                    playSfx("select");
                    state = "mode_select";
                }
                if (aPressed || bPressed) {
                    playSfx("select");
                    currentHighScores = loadHighScores(gameMode, difficulty);
                    highScoreScrollOffset = 0;
                    hsComboIndex = gameModes.indexOf(gameMode) * difficulties.length + difficulties.indexOf(difficulty);
                    state = "high_scores";
                }
                break;

            case "mode_select":
                drawModeSelect();
                if (menuDown) {
                    modeIndex = (modeIndex + 1) % gameModes.length;
                    playSfx("navigate");
                }
                if (menuUp) {
                    modeIndex = (modeIndex - 1 + gameModes.length) % gameModes.length;
                    playSfx("navigate");
                }
                gameMode = gameModes[modeIndex];
                if (startPressed) {
                    playSfx("select");
                    state = "difficulty";
                }
                break;

            case "difficulty":
                drawDifficultySelect();
                if (menuDown) {
                    difficultyIndex = (difficultyIndex + 1) % difficulties.length;
                    playSfx("navigate");
                }
                if (menuUp) {
                    difficultyIndex = (difficultyIndex - 1 + difficulties.length) % difficulties.length;
                    playSfx("navigate");
                }
                difficulty = difficulties[difficultyIndex];
                if (aPressed) {
                    negativeMode = !negativeMode;
                    playSfx("toggle");
                }
                if (startPressed) {
                    playSfx("select");
                    startGame();
                }
                break;

            case "loading_photo":
                drawLoading();
                // Allow user to go back on error
                if (photoFetchError && startPressed) {
                    photoFetchError = null;
                    state = "title";
                }
                break;

            case "memorize": {
                const memTime = getMemorizeTime() * 1000;
                const elapsed = now - phaseStartTime;
                const remaining = Math.max(0, (memTime - elapsed) / 1000);
                drawMemorize(remaining);
                if (elapsed >= memTime) {
                    const snap = captureFrame();
                    state = "search";
                    phaseStartTime = now;
                    transition = {
                        type: "dissolve",
                        startTime: now,
                        duration: 800,
                        fromSnapshot: snap,
                    };
                    // Don't let transition eat into search time
                    phaseStartTime = now + 800;
                }
                break;
            }

            case "search": {
                const selTime = getSearchTime() * 1000;
                const elapsed = now - phaseStartTime;
                const remaining = Math.max(0, Math.ceil((selTime - elapsed) / 1000));

                if (gameMode !== "photo") {
                    // Gradient mode switching
                    if (aPressed) {
                        gradModeIndex = (gradModeIndex + 1) % GRADIENT_MODES.length;
                        renderGradient();
                    }
                    if (bPressed) {
                        gradModeIndex = (gradModeIndex - 1 + GRADIENT_MODES.length) % GRADIENT_MODES.length;
                        renderGradient();
                    }
                }

                // Move cursor
                cursorX = p.constrain(cursorX + dx * SPINNER_SPEED, 0, GRAD_W - 1);
                cursorY = p.constrain(cursorY + dy * SPINNER_SPEED, 0, GRAD_H - 1);

                // Movement-driven melody: accumulate movement, play next note at threshold
                const movement = Math.abs(dx) + Math.abs(dy);
                if (movement > 0) {
                    melodyMovementAccum += movement;
                    while (melodyMovementAccum >= MELODY_MOVEMENT_THRESHOLD) {
                        melodyMovementAccum -= MELODY_MOVEMENT_THRESHOLD;
                        const melody = MELODIES[melodyIndex];
                        playMelodyNote(melody.notes[melodyNoteIndex]);
                        melodyNoteIndex = (melodyNoteIndex + 1) % melody.notes.length;
                    }
                }

                const px = Math.floor(cursorX);
                const py = Math.floor(cursorY);

                let picked: [number, number, number];
                if (gameMode === "photo" && photoRounds[round]) {
                    picked = samplePhotoPixel(photoRounds[round].photo, px, py);
                } else {
                    const mode = GRADIENT_MODES[gradModeIndex];
                    picked = mode.colorAt(px / (GRAD_W - 1), py / (GRAD_H - 1));
                }

                drawSearch(px, py, picked, remaining);

                // Lock in with START or time runs out
                if (startPressed) playSfx("lockin");
                if (startPressed || elapsed >= selTime) {
                    let accuracy = computeAccuracy(
                        difficulty,
                        targetColor[0], targetColor[1], targetColor[2],
                        picked[0], picked[1], picked[2]
                    );
                    if (negativeMode) accuracy = Math.min(100, accuracy * 1.1);
                    results.push({ target: targetColor, picked, accuracy, pickedPos: [px, py] });
                    state = "round_reveal";
                    phaseStartTime = now;
                }
                break;
            }

            case "round_reveal":
                drawRoundReveal();
                if (startPressed || (now - phaseStartTime > 2000)) {
                    state = "round_result";
                    phaseStartTime = now;
                    playResultJingle(results[results.length - 1].accuracy);
                }
                break;

            case "round_result":
                drawRoundResult();
                if (startPressed || (now - phaseStartTime > 3000)) {
                    round++;
                    if (isGameOver()) {
                        transition = {
                            type: "fade",
                            startTime: now,
                            duration: 400,
                        };
                        finalScrollOffset = 0;
                        state = "final_result";
                    } else {
                        transition = {
                            type: "fade",
                            startTime: now,
                            duration: 400,
                        };
                        startRound();
                    }
                }
                break;

            case "final_result": {
                const maxVisible = 5;
                const maxScroll = Math.max(0, results.length - maxVisible);
                if (menuDown && finalScrollOffset < maxScroll) {
                    finalScrollOffset++;
                    playSfx("navigate");
                }
                if (menuUp && finalScrollOffset > 0) {
                    finalScrollOffset--;
                    playSfx("navigate");
                }
                drawFinalResult();
                if (startPressed) {
                    playSfx("select");
                    playerFinalScore = results.reduce((s, r) => s + r.accuracy, 0) / results.length;
                    if (qualifiesForHighScore(gameMode, difficulty, playerFinalScore)) {
                        initialsChars = [0, 0, 0];
                        initialsPos = 0;
                        state = "enter_initials";
                    } else {
                        currentHighScores = loadHighScores(gameMode, difficulty);
                        highScoreScrollOffset = 0;
                        hsComboIndex = gameModes.indexOf(gameMode) * difficulties.length + difficulties.indexOf(difficulty);
                        state = "high_scores";
                    }
                }
                break;
            }

            case "enter_initials":
                drawEnterInitials();
                if (menuUp) {
                    initialsChars[initialsPos] = (initialsChars[initialsPos] + 1) % ALPHABET.length;
                    playSfx("navigate");
                }
                if (menuDown) {
                    initialsChars[initialsPos] = (initialsChars[initialsPos] - 1 + ALPHABET.length) % ALPHABET.length;
                    playSfx("navigate");
                }
                if (aPressed || bPressed) {
                    playSfx("select");
                    if (initialsPos < 2) {
                        initialsPos++;
                    } else {
                        // All 3 letters entered — save and show board
                        const initials = initialsChars.map(i => ALPHABET[i]).join("");
                        currentHighScores = insertHighScore(gameMode, difficulty, {
                            initials,
                            score: playerFinalScore,
                            date: new Date().toISOString().slice(0, 10),
                        });
                        highScoreScrollOffset = 0;
                        hsComboIndex = gameModes.indexOf(gameMode) * difficulties.length + difficulties.indexOf(difficulty);
                        state = "high_scores";
                    }
                }
                break;

            case "high_scores": {
                const totalCombos = gameModes.length * difficulties.length;
                if (aPressed) {
                    hsComboIndex = (hsComboIndex + 1) % totalCombos;
                    const browseMode = gameModes[Math.floor(hsComboIndex / difficulties.length)];
                    const browseDiff = difficulties[hsComboIndex % difficulties.length];
                    currentHighScores = loadHighScores(browseMode, browseDiff);
                    highScoreScrollOffset = 0;
                    playSfx("toggle");
                }
                if (bPressed) {
                    hsComboIndex = (hsComboIndex - 1 + totalCombos) % totalCombos;
                    const browseMode = gameModes[Math.floor(hsComboIndex / difficulties.length)];
                    const browseDiff = difficulties[hsComboIndex % difficulties.length];
                    currentHighScores = loadHighScores(browseMode, browseDiff);
                    highScoreScrollOffset = 0;
                    playSfx("toggle");
                }
                const hsMaxVisible = 7;
                const hsMaxScroll = Math.max(0, currentHighScores.length - hsMaxVisible);
                if (menuDown && highScoreScrollOffset < hsMaxScroll) {
                    highScoreScrollOffset++;
                    playSfx("navigate");
                }
                if (menuUp && highScoreScrollOffset > 0) {
                    highScoreScrollOffset--;
                    playSfx("navigate");
                }
                drawHighScores();
                if (startPressed) {
                    playSfx("select");
                    state = "title";
                }
                break;
            }
        }

        // Render transition overlay
        if (transition) {
            const elapsed = now - transition.startTime;
            const progress = Math.min(1, elapsed / transition.duration);

            if (transition.type === "dissolve" && transition.fromSnapshot) {
                drawDissolveOverlay(transition.fromSnapshot, progress);
            } else if (transition.type === "fade") {
                p.fill(26, 26, 46, (1 - progress) * 255);
                p.noStroke();
                p.rect(0, 0, WIDTH, HEIGHT);
            }

            if (progress >= 1) transition = null;
        }

        prevA = aDown;
        prevB = bDown;
        prevStart = startDown;
        prevUp = upDown;
        prevDown = downDown;
    };

    // --- Drawing functions ---

    // Rainbow border animation for the title screen.
    // Color segments crawl clockwise around the screen perimeter,
    // and the border thickness pulses gently (breathing effect).
    const SEGMENT_LENGTH = 8; // pixels per color segment
    const LOOP_DURATION = 10000; // ms for a full hue rotation
    const PERIMETER = 2 * (WIDTH + HEIGHT) - 4;
    const BORDER_MIN = 2;
    const BORDER_MAX = 10;
    const PULSE_SPEED = 2000; // ms per full breath cycle

    function drawRainbowBorder() {
        const t = p.millis();
        // Pulsing border thickness
        const pulse = (Math.sin(t / PULSE_SPEED * Math.PI * 2) + 1) / 2; // 0..1
        const thickness = BORDER_MIN + pulse * (BORDER_MAX - BORDER_MIN);
        // Hue offset shifts over time so colors rotate
        const hueOffset = (t / LOOP_DURATION) * 360;

        p.noStroke();
        for (let i = 0; i < PERIMETER; i += SEGMENT_LENGTH) {
            const hue = (hueOffset + (i / PERIMETER) * 360) % 360;
            const [r, g, b] = hsbToRgb(hue, 90, 95);
            p.fill(r, g, b);

            // Convert perimeter position to x,y rectangle
            // Top edge: left to right
            if (i < WIDTH) {
                const segLen = Math.min(SEGMENT_LENGTH, WIDTH - i);
                p.rect(i, 0, segLen, thickness);
            }
            // Right edge: top to bottom
            else if (i < WIDTH + HEIGHT - 1) {
                const y = i - WIDTH + 1;
                const segLen = Math.min(SEGMENT_LENGTH, HEIGHT - y);
                p.rect(WIDTH - thickness, y, thickness, segLen);
            }
            // Bottom edge: right to left
            else if (i < 2 * WIDTH + HEIGHT - 2) {
                const x = WIDTH - 1 - (i - WIDTH - HEIGHT + 2);
                const segLen = Math.min(SEGMENT_LENGTH, x + 1);
                p.rect(x - segLen + 1, HEIGHT - thickness, segLen, thickness);
            }
            // Left edge: bottom to top
            else {
                const y = HEIGHT - 1 - (i - 2 * WIDTH - HEIGHT + 3);
                const segLen = Math.min(SEGMENT_LENGTH, y + 1);
                p.rect(0, y - segLen + 1, thickness, segLen);
            }
        }
    }

    function drawTitle() {
        p.background(26, 26, 46);

        // Animated rainbow border
        drawRainbowBorder();

        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(20);
        p.text("Color Matcher", WIDTH / 2, HEIGHT / 2 - 30);
        p.textSize(10);
        p.fill(180);
        p.text("Memorize. Match. Master.", WIDTH / 2, HEIGHT / 2);
        p.fill(255);
        p.textSize(12);
        p.text("Press 1P START", WIDTH / 2, HEIGHT / 2 + 40);
        p.fill(140);
        p.textSize(7);
        p.text("A/B: high scores", WIDTH / 2, HEIGHT / 2 + 60);
    }

    function drawModeSelect() {
        p.background(26, 26, 46);
        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(16);
        p.text("Select Mode", WIDTH / 2, 35);

        p.textSize(13);
        for (let i = 0; i < gameModes.length; i++) {
            const selected = i === modeIndex;
            p.fill(selected ? 255 : 120);
            const prefix = selected ? "> " : "  ";
            p.text(`${prefix}${MODE_LABELS[gameModes[i]]}`, WIDTH / 2, 80 + i * 28);
        }

        // Description (two lines)
        p.fill(180);
        p.textSize(7);
        const desc = MODE_DESCRIPTIONS[gameMode];
        p.text(desc[0], WIDTH / 2, 170);
        p.text(desc[1], WIDTH / 2, 185);

        p.fill(255);
        p.textSize(7);
        p.text("UP/DOWN: change", WIDTH / 2, 225);
        p.text("START: select", WIDTH / 2, 240);
    }

    function drawDifficultySelect() {
        p.background(26, 26, 46);
        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(14);
        p.text("Difficulty", WIDTH / 2, 35);

        p.textSize(13);
        for (let i = 0; i < difficulties.length; i++) {
            const selected = i === difficultyIndex;
            p.fill(selected ? 255 : 120);
            const prefix = selected ? "> " : "  ";
            p.text(`${prefix}${DIFFICULTY_LABELS[difficulties[i]]}`, WIDTH / 2, 80 + i * 28);
        }

        p.fill(180);
        p.textSize(7);
        const explanations: Record<Difficulty, string[]> = {
            easy: ["Weighted RGB", "Forgiving scoring"],
            medium: ["Euclidean RGB", "Raw color distance"],
            hard: ["CIE76 Lab", "Perceptually precise"],
        };
        const lines = explanations[difficulty];
        p.text(lines[0], WIDTH / 2, 170);
        p.text(lines[1], WIDTH / 2, 185);

        // Negative mode toggle
        p.textSize(7);
        p.fill(negativeMode ? 255 : 120);
        p.text(`Negative: ${negativeMode ? "ON" : "OFF"}`, WIDTH / 2, 200);

        p.fill(255);
        p.textSize(7);
        p.text("UP/DOWN: difficulty  A: negative", WIDTH / 2, 225);
        p.text("START: begin", WIDTH / 2, 240);
    }

    function drawLoading() {
        p.background(26, 26, 46);
        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        if (photoFetchError) {
            p.textSize(10);
            p.text("Load failed", WIDTH / 2, HEIGHT / 2 - 15);
            p.textSize(6);
            p.fill(180);
            p.text(photoFetchError, WIDTH / 2, HEIGHT / 2 + 10);
            p.fill(255);
            p.textSize(7);
            p.text("START: go back", WIDTH / 2, HEIGHT / 2 + 35);
        } else {
            p.textSize(10);
            p.text("Loading", WIDTH / 2, HEIGHT / 2 - 15);
            p.text("photos", WIDTH / 2, HEIGHT / 2 + 5);
            const dots = ".".repeat(Math.floor((p.millis() / 400) % 4));
            p.text(dots, WIDTH / 2, HEIGHT / 2 + 25);
        }
    }

    function drawMemorize(remaining: number) {
        const displayColor: [number, number, number] = negativeMode
            ? [255 - targetColor[0], 255 - targetColor[1], 255 - targetColor[2]]
            : targetColor;
        p.background(displayColor[0], displayColor[1], displayColor[2]);

        // Main info overlay
        p.fill(0, 0, 0, 120);
        p.noStroke();
        const overlayH = negativeMode ? 96 : 80;
        p.rect(WIDTH / 2 - 110, HEIGHT / 2 - 48, 220, overlayH, 4);

        p.fill(255);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(9);
        p.text(
            `Round ${round + 1} of ${getTotalRoundsLabel()}`,
            WIDTH / 2,
            HEIGHT / 2 - 30
        );
        p.textSize(7);
        p.text("Memorize this!", WIDTH / 2, HEIGHT / 2 - 12);
        if (negativeMode) {
            p.fill(255, 200, 80);
            p.textSize(6);
            p.text("NEGATIVE MODE - invert this color!", WIDTH / 2, HEIGHT / 2 + 2);
            p.fill(255);
        }
        p.textSize(16);
        const timerY = negativeMode ? HEIGHT / 2 + 26 : HEIGHT / 2 + 22;
        p.text(remaining < 1 ? remaining.toFixed(1) : Math.ceil(remaining).toString(), WIDTH / 2, timerY);

        // Color theory tip at the bottom
        const tip = COLOR_TIPS[tipIndex];
        p.fill(0, 0, 0, 100);
        p.noStroke();
        const tipLines = tip.split("\n");
        const tipH = tipLines.length * 12 + 8;
        p.rect(WIDTH / 2 - 140, HEIGHT - tipH - 8, 280, tipH, 3);
        p.fill(200);
        p.textSize(6);
        for (let i = 0; i < tipLines.length; i++) {
            p.text(tipLines[i], WIDTH / 2, HEIGHT - tipH - 8 + 8 + i * 12);
        }
    }

    function drawSearch(
        px: number,
        py: number,
        picked: [number, number, number],
        remaining: number
    ) {
        // Background = currently selected color
        p.background(picked[0], picked[1], picked[2]);

        // Black border
        p.fill(0);
        p.noStroke();
        p.rect(GRAD_X - 1, GRAD_Y - 1, GRAD_W + 2, GRAD_H + 2);

        // Draw the search surface: gradient or photo
        if (gameMode === "photo" && photoRounds[round]) {
            p.image(photoRounds[round].p5img, GRAD_X, GRAD_Y);
        } else {
            p.image(gradientImg, GRAD_X, GRAD_Y);
        }

        // Labels above gradient
        p.fill(255);
        p.noStroke();
        p.textSize(8);
        p.textAlign(p.LEFT, p.BOTTOM);
        if (gameMode === "photo") {
            p.text("Photo of the Day", GRAD_X, GRAD_Y - 4);
        } else {
            p.text(GRADIENT_MODES[gradModeIndex].name, GRAD_X, GRAD_Y - 4);
        }

        p.textAlign(p.RIGHT, p.BOTTOM);
        p.text(
            `Round ${round + 1}/${getTotalRoundsLabel()}  ${remaining}s`,
            GRAD_X + GRAD_W,
            GRAD_Y - 4
        );

        // Pulsing cursor
        const pulse = Math.sin(p.millis() / 300) * 1.5;
        const cursorSize = 7 + pulse;
        const screenX = GRAD_X + px;
        const screenY = GRAD_Y + py;
        p.noFill();
        p.stroke(255);
        p.strokeWeight(1);
        p.rect(
            screenX - cursorSize / 2,
            screenY - cursorSize / 2,
            cursorSize,
            cursorSize
        );
        p.stroke(0);
        p.rect(
            screenX - cursorSize / 2 + 1,
            screenY - cursorSize / 2 + 1,
            cursorSize - 2,
            cursorSize - 2
        );

        // Song name (subtle)
        p.fill(255, 255, 255, 100);
        p.noStroke();
        p.textSize(5);
        p.textAlign(p.LEFT, p.TOP);
        p.text(MELODIES[melodyIndex].name, GRAD_X, GRAD_Y + GRAD_H + 4);

        // Hint below gradient
        p.fill(255);
        p.noStroke();
        p.textSize(8);
        p.textAlign(p.CENTER, p.TOP);
        if (gameMode === "photo") {
            p.text("START: lock in", WIDTH / 2, GRAD_Y + GRAD_H + 14);
        } else {
            p.text("A/B: mode   START: lock in", WIDTH / 2, GRAD_Y + GRAD_H + 14);
        }
    }

    /** Find the pixel on the current search surface closest to the target color */
    function findTargetOnSurface(
        target: [number, number, number]
    ): [number, number] {
        let bestX = 0, bestY = 0, bestDist = Infinity;
        // Sample every 4th pixel for speed (64k / 16 = 4k checks)
        const step = 4;
        for (let y = 0; y < GRAD_H; y += step) {
            for (let x = 0; x < GRAD_W; x += step) {
                let color: [number, number, number];
                if (gameMode === "photo" && photoRounds[round]) {
                    color = samplePhotoPixel(photoRounds[round].photo, x, y);
                } else {
                    color = GRADIENT_MODES[gradModeIndex].colorAt(
                        x / (GRAD_W - 1), y / (GRAD_H - 1)
                    );
                }
                const dr = target[0] - color[0];
                const dg = target[1] - color[1];
                const db = target[2] - color[2];
                const dist = dr * dr + dg * dg + db * db;
                if (dist < bestDist) {
                    bestDist = dist;
                    bestX = x;
                    bestY = y;
                }
            }
        }
        return [bestX, bestY];
    }

    function drawRoundReveal() {
        const result = results[results.length - 1];
        const [pickedX, pickedY] = result.pickedPos;
        const [targetX, targetY] = findTargetOnSurface(result.target);

        p.background(26, 26, 46);

        // Black border
        p.fill(0);
        p.noStroke();
        p.rect(GRAD_X - 1, GRAD_Y - 1, GRAD_W + 2, GRAD_H + 2);

        // Draw the search surface
        if (gameMode === "photo" && photoRounds[round]) {
            p.image(photoRounds[round].p5img, GRAD_X, GRAD_Y);
        } else {
            p.image(gradientImg, GRAD_X, GRAD_Y);
        }

        // Target crosshair (green)
        const tx = GRAD_X + targetX;
        const ty = GRAD_Y + targetY;
        p.stroke(0, 255, 0);
        p.strokeWeight(1);
        p.line(tx - 8, ty, tx + 8, ty);
        p.line(tx, ty - 8, tx, ty + 8);
        p.noFill();
        p.ellipse(tx, ty, 12, 12);

        // Player's pick crosshair (white)
        const px = GRAD_X + pickedX;
        const py = GRAD_Y + pickedY;
        p.stroke(255);
        p.line(px - 6, py, px + 6, py);
        p.line(px, py - 6, px, py + 6);
        p.noFill();
        p.rect(px - 4, py - 4, 8, 8);

        // Labels above
        p.noStroke();
        p.textAlign(p.LEFT, p.BOTTOM);
        p.textSize(7);
        p.fill(0, 255, 0);
        p.text("+ Target", GRAD_X, GRAD_Y - 4);
        p.fill(255);
        p.textAlign(p.RIGHT, p.BOTTOM);
        p.text("Yours +", GRAD_X + GRAD_W, GRAD_Y - 4);

        // Accuracy below
        p.textAlign(p.CENTER, p.TOP);
        p.fill(255);
        p.textSize(9);
        p.text(`${result.accuracy.toFixed(1)}%`, WIDTH / 2, GRAD_Y + GRAD_H + 5);
    }

    function drawRoundResult() {
        const result = results[results.length - 1];
        const [tr, tg, tb] = result.target;
        const [pr, pg, pb] = result.picked;
        const acc = result.accuracy;

        p.background(26, 26, 46);

        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(14);
        p.text(`Round ${round + 1} Result`, WIDTH / 2, 30);

        const swatchW = 80;
        const swatchH = 80;
        const gap = 40;
        const leftX = WIDTH / 2 - gap / 2 - swatchW;
        const topY = 55;

        // Target swatch
        p.fill(255);
        p.textSize(9);
        p.textAlign(p.CENTER, p.BOTTOM);
        p.text("Target", leftX + swatchW / 2, topY - 3);
        p.fill(tr, tg, tb);
        p.stroke(255);
        p.strokeWeight(1);
        p.rect(leftX, topY, swatchW, swatchH);

        // Picked swatch
        const rightX = WIDTH / 2 + gap / 2;
        p.fill(255);
        p.noStroke();
        p.textSize(9);
        p.textAlign(p.CENTER, p.BOTTOM);
        p.text("Yours", rightX + swatchW / 2, topY - 3);
        p.fill(pr, pg, pb);
        p.stroke(255);
        p.strokeWeight(1);
        p.rect(rightX, topY, swatchW, swatchH);

        // Accuracy
        p.noStroke();
        p.fill(255);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(20);
        p.text(`${acc.toFixed(1)}%`, WIDTH / 2, topY + swatchH + 30);

        // Rating
        p.textSize(10);
        p.fill(180);
        let rating: string;
        if (acc >= 95) rating = "Perfect eye!";
        else if (acc >= 85) rating = "Great match!";
        else if (acc >= 70) rating = "Pretty close!";
        else if (acc >= 50) rating = "Not bad...";
        else rating = "Keep practicing!";
        p.text(rating, WIDTH / 2, topY + swatchH + 52);

        // Anxiety mode: warn if below 50%
        if (gameMode === "anxiety" && acc < 50) {
            p.fill(255, 80, 80);
            p.textSize(9);
            p.text("Below 50% - Game Over!", WIDTH / 2, topY + swatchH + 68);
        }
    }

    function drawFinalResult() {
        p.background(26, 26, 46);

        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(16);

        if (gameMode === "anxiety") {
            p.text("Game Over!", WIDTH / 2, 18);
            p.textSize(11);
            const streak = results.length;
            const avgAcc =
                results.reduce((s, r) => s + r.accuracy, 0) / results.length;
            p.text(
                `Streak: ${streak}   Avg: ${avgAcc.toFixed(1)}%`,
                WIDTH / 2,
                38
            );
        } else {
            p.text("Game Over!", WIDTH / 2, 18);
            const avgAcc =
                results.reduce((s, r) => s + r.accuracy, 0) / results.length;
            p.textSize(14);
            p.text(`Total: ${avgAcc.toFixed(1)}%`, WIDTH / 2, 40);
        }

        // Per-round breakdown — show up to 5 results, scrollable
        const maxVisible = 5;
        const startY = 58;
        const rowH = 36;
        const swatchSize = 22;
        const visibleCount = Math.min(maxVisible, results.length);

        for (let i = 0; i < visibleCount; i++) {
            const ri = finalScrollOffset + i;
            if (ri >= results.length) break;
            const r = results[ri];
            const y = startY + i * rowH;
            const roundNum = ri + 1;

            p.fill(180);
            p.textSize(9);
            p.textAlign(p.RIGHT, p.CENTER);
            p.text(`R${roundNum}`, 40, y + swatchSize / 2);

            p.fill(r.target[0], r.target[1], r.target[2]);
            p.stroke(80);
            p.strokeWeight(1);
            p.rect(48, y, swatchSize, swatchSize);

            p.noStroke();
            p.fill(120);
            p.textSize(9);
            p.textAlign(p.CENTER, p.CENTER);
            p.text("-", 48 + swatchSize + 12, y + swatchSize / 2);

            p.fill(r.picked[0], r.picked[1], r.picked[2]);
            p.stroke(80);
            p.strokeWeight(1);
            p.rect(48 + swatchSize + 24, y, swatchSize, swatchSize);

            p.noStroke();
            p.fill(255);
            p.textSize(11);
            p.textAlign(p.LEFT, p.CENTER);
            p.text(
                `${r.accuracy.toFixed(1)}%`,
                48 + swatchSize * 2 + 32,
                y + swatchSize / 2
            );

            const barX = 200;
            const barW = 110;
            const barH = 10;
            const barY = y + swatchSize / 2 - barH / 2;
            p.fill(50);
            p.noStroke();
            p.rect(barX, barY, barW, barH);
            if (r.accuracy >= 85) p.fill(80, 200, 80);
            else if (r.accuracy >= 50) p.fill(200, 200, 80);
            else p.fill(200, 80, 80);
            p.rect(barX, barY, barW * (r.accuracy / 100), barH);
        }

        // Scroll indicators
        if (results.length > maxVisible) {
            p.fill(255, 255, 255, finalScrollOffset > 0 ? 200 : 50);
            p.noStroke();
            p.textSize(8);
            p.textAlign(p.CENTER, p.BOTTOM);
            p.text("^", WIDTH / 2, startY - 2);

            p.fill(255, 255, 255, finalScrollOffset < results.length - maxVisible ? 200 : 50);
            p.textAlign(p.CENTER, p.TOP);
            p.text("v", WIDTH / 2, startY + maxVisible * rowH);
        }

        // Photo mode: show palette strip with hex codes
        if (gameMode === "photo" && photoRounds.length > 0) {
            const paletteY = startY + visibleCount * rowH + 2;
            const palW = 40;
            const palH = 12;
            const totalW = palW * Math.min(5, photoRounds.length);
            const palX = Math.floor((WIDTH - totalW) / 2);
            p.textSize(5);
            p.textAlign(p.CENTER, p.TOP);
            for (let i = 0; i < Math.min(5, photoRounds.length); i++) {
                const c = photoRounds[i].targetColor;
                p.fill(c[0], c[1], c[2]);
                p.noStroke();
                p.rect(palX + i * palW, paletteY, palW, palH);
                p.fill(255);
                p.text(rgbToHex(c[0], c[1], c[2]), palX + i * palW + palW / 2, paletteY + palH + 1);
            }
        }

        // Mode + difficulty
        p.fill(120);
        p.textSize(6);
        p.textAlign(p.CENTER, p.CENTER);
        p.text(
            `${MODE_LABELS[gameMode]} - ${DIFFICULTY_LABELS[difficulty]}`,
            WIDTH / 2,
            HEIGHT - 24
        );

        p.fill(255);
        p.textSize(7);
        p.text("START: continue", WIDTH / 2, HEIGHT - 12);
    }

    function drawEnterInitials() {
        p.background(26, 26, 46);

        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(14);
        p.text("New High Score!", WIDTH / 2, 30);

        p.textSize(16);
        p.text(`${playerFinalScore.toFixed(1)}%`, WIDTH / 2, 58);

        p.textSize(10);
        p.fill(180);
        p.text("Enter your initials", WIDTH / 2, 88);

        // Draw the 3 letter slots
        const slotW = 36;
        const slotGap = 12;
        const totalW = slotW * 3 + slotGap * 2;
        const slotStartX = (WIDTH - totalW) / 2;
        const slotY = 110;
        const slotH = 44;

        for (let i = 0; i < 3; i++) {
            const x = slotStartX + i * (slotW + slotGap);
            const active = i === initialsPos;

            // Slot background
            p.fill(active ? 60 : 40);
            p.noStroke();
            p.rect(x, slotY, slotW, slotH, 3);

            // Letter
            p.fill(active ? 255 : 150);
            p.textSize(22);
            p.textAlign(p.CENTER, p.CENTER);
            p.text(ALPHABET[initialsChars[i]], x + slotW / 2, slotY + slotH / 2);

            // Up/down arrows on active slot
            if (active) {
                p.fill(255, 255, 255, 150);
                p.textSize(10);
                p.text("^", x + slotW / 2, slotY - 10);
                p.text("v", x + slotW / 2, slotY + slotH + 10);
            }

            // Underline completed letters
            if (i < initialsPos) {
                p.fill(80, 200, 80);
                p.noStroke();
                p.rect(x + 4, slotY + slotH - 4, slotW - 8, 2);
            }
        }

        p.fill(180);
        p.textSize(7);
        p.textAlign(p.CENTER, p.CENTER);
        p.text(`${MODE_LABELS[gameMode]} - ${DIFFICULTY_LABELS[difficulty]}`, WIDTH / 2, 190);

        p.fill(255);
        p.textSize(7);
        p.text("UP/DOWN: change letter", WIDTH / 2, 220);
        p.text("A/B: confirm letter", WIDTH / 2, 235);
    }

    function drawHighScores() {
        p.background(26, 26, 46);

        p.fill(255);
        p.noStroke();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(14);
        p.text("High Scores", WIDTH / 2, 18);

        const browseMode = gameModes[Math.floor(hsComboIndex / difficulties.length)];
        const browseDiff = difficulties[hsComboIndex % difficulties.length];

        p.fill(180);
        p.textSize(7);
        p.text(`< ${MODE_LABELS[browseMode]} - ${DIFFICULTY_LABELS[browseDiff]} >`, WIDTH / 2, 38);

        const startY = 54;
        const rowH = 22;
        const maxVisible = 7;
        const visibleCount = Math.min(maxVisible, currentHighScores.length);

        if (currentHighScores.length === 0) {
            p.fill(120);
            p.textSize(9);
            p.text("No scores yet!", WIDTH / 2, HEIGHT / 2);
        }

        for (let i = 0; i < visibleCount; i++) {
            const si = highScoreScrollOffset + i;
            if (si >= currentHighScores.length) break;
            const entry = currentHighScores[si];
            const y = startY + i * rowH;
            const rank = si + 1;

            // Highlight if this is the player's just-entered score
            const isNew = entry.score === playerFinalScore && state === "high_scores";

            // Rank
            if (rank === 1) p.fill(255, 215, 0);       // gold
            else if (rank === 2) p.fill(192, 192, 192); // silver
            else if (rank === 3) p.fill(205, 127, 50);  // bronze
            else p.fill(120);
            p.textSize(9);
            p.textAlign(p.RIGHT, p.CENTER);
            p.text(`${rank}.`, 40, y + rowH / 2);

            // Initials
            p.fill(isNew ? 255 : 200);
            p.textSize(11);
            p.textAlign(p.LEFT, p.CENTER);
            p.text(entry.initials, 52, y + rowH / 2);

            // Score
            p.fill(isNew ? 255 : 200);
            p.textSize(11);
            p.textAlign(p.RIGHT, p.CENTER);
            p.text(`${entry.score.toFixed(1)}%`, 220, y + rowH / 2);

            // Bar
            const barX = 230;
            const barW = 80;
            const barH = 8;
            const barY = y + rowH / 2 - barH / 2;
            p.fill(50);
            p.noStroke();
            p.rect(barX, barY, barW, barH);
            if (entry.score >= 85) p.fill(80, 200, 80);
            else if (entry.score >= 50) p.fill(200, 200, 80);
            else p.fill(200, 80, 80);
            p.rect(barX, barY, barW * (entry.score / 100), barH);

            // Date
            p.fill(100);
            p.textSize(5);
            p.textAlign(p.RIGHT, p.CENTER);
            p.text(entry.date, WIDTH - 8, y + rowH / 2);
        }

        // Scroll indicators
        if (currentHighScores.length > maxVisible) {
            p.fill(255, 255, 255, highScoreScrollOffset > 0 ? 200 : 50);
            p.noStroke();
            p.textSize(8);
            p.textAlign(p.CENTER, p.BOTTOM);
            p.text("^", WIDTH / 2, startY - 2);

            p.fill(255, 255, 255, highScoreScrollOffset < currentHighScores.length - maxVisible ? 200 : 50);
            p.textAlign(p.CENTER, p.TOP);
            p.text("v", WIDTH / 2, startY + maxVisible * rowH);
        }

        p.fill(255);
        p.textSize(6);
        p.textAlign(p.CENTER, p.CENTER);
        p.text("A/B: change mode   START: title screen", WIDTH / 2, HEIGHT - 12);
    }
};

/** Convert HSB (h: 0-360, s: 0-100, b: 0-100) to RGB (0-255 each) */
function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
    const s1 = s / 100;
    const b1 = b / 100;
    const c = b1 * s1;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = b1 - c;

    let r1: number, g1: number, b1_: number;
    if (h < 60) {
        [r1, g1, b1_] = [c, x, 0];
    } else if (h < 120) {
        [r1, g1, b1_] = [x, c, 0];
    } else if (h < 180) {
        [r1, g1, b1_] = [0, c, x];
    } else if (h < 240) {
        [r1, g1, b1_] = [0, x, c];
    } else if (h < 300) {
        [r1, g1, b1_] = [x, 0, c];
    } else {
        [r1, g1, b1_] = [c, 0, x];
    }

    return [
        Math.round((r1 + m) * 255),
        Math.round((g1 + m) * 255),
        Math.round((b1_ + m) * 255),
    ];
}

new p5(sketch, document.getElementById("sketch")!);
