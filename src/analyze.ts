import type { VisionConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { loadImage } from "./image.js";
import { requestVisionCompletion, type VisionCompletion } from "./provider.js";
import { extractVideoFrames } from "./video.js";

const DEFAULT_IMAGE_PROMPT =
  "Describe this image accurately. Include visible text, layout, objects, colors, and details relevant to understanding it. Do not invent details that are not visible.";

const DEFAULT_VIDEO_PROMPT =
  "Analyze these evenly sampled video frames as one timeline. Describe the sequence of events, scene or UI changes, actions, and visible text. Distinguish observations from uncertainty.";

export async function analyzeImage(options: {
  source: string;
  prompt?: string;
  config?: VisionConfig;
}): Promise<VisionCompletion> {
  const config = options.config ?? loadConfig();
  const image = await loadImage(options.source, config);
  return requestVisionCompletion({
    config,
    prompt: options.prompt?.trim() || DEFAULT_IMAGE_PROMPT,
    images: [{ dataUrl: image.dataUrl, label: image.label }],
  });
}

export async function analyzeVideo(options: {
  source: string;
  prompt?: string;
  maxFrames?: number;
  config?: VisionConfig;
}): Promise<VisionCompletion> {
  const config = options.config ?? loadConfig();
  const frames = await extractVideoFrames({
    source: options.source,
    maxFrames: options.maxFrames ?? 8,
    config,
  });
  const userPrompt = options.prompt?.trim();
  return requestVisionCompletion({
    config,
    prompt: userPrompt
      ? `${DEFAULT_VIDEO_PROMPT}\n\nUser question: ${userPrompt}`
      : DEFAULT_VIDEO_PROMPT,
    images: frames,
  });
}
