import { z } from "zod";
import { modelSchema } from "../contracts/ui.js";

const filename = z.string().min(1).max(1024).refine(
  (value) => value !== "." && value !== ".." && !/[\/\\\u0000-\u001f\u007f-\u009f]/u.test(value),
  { message: "Model files must be safe basenames" },
);
const repository = z.string().max(1024).refine(
  (value) => value === "" || /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value),
  { message: "Model repositories must name an owner and repository" },
);
export const catalogModelSchema = modelSchema.extend({ file: filename, repository }).readonly();
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export const hardwareTierSchema = z.enum(["strong", "weak", "cpuOnly"]);
export type HardwareTier = z.infer<typeof hardwareTierSchema>;
const pickSchema = z.strictObject({ parakeet: z.string().min(1).max(1024), whisper: z.string().min(1).max(1024) }).readonly();
export const catalogSchema = z.strictObject({
  $comment: z.string().max(8192).optional(),
  models: z.array(catalogModelSchema).min(1).max(128).readonly(),
  recommendations: z.strictObject({
    $comment: z.string().max(8192).optional(),
    strong: pickSchema.optional(), weak: pickSchema.optional(), cpuOnly: pickSchema.optional(),
  }).readonly(),
  parakeetLanguages: z.array(z.string().regex(/^[a-z]{2}$/u)).max(128).readonly(),
}).refine((catalog) => new Set(catalog.models.map((model) => model.id)).size === catalog.models.length,
  { message: "Model identifiers must be unique", path: ["models"] }).readonly();
export type Catalog = z.infer<typeof catalogSchema>;

export function parseModelCatalog(input: unknown): Catalog { return catalogSchema.parse(input); }
export function modelById(catalog: Catalog, id: string): CatalogModel | undefined {
  return catalog.models.find((model) => model.id === id);
}
export function recommendationsFor(catalog: Catalog, tier: HardwareTier, language: string): CatalogModel[] {
  const pick = catalog.recommendations[tier];
  if (!pick) return [];
  const parakeet = modelById(catalog, pick.parakeet), whisper = modelById(catalog, pick.whisper);
  if (!parakeet || !whisper) return [];
  return catalog.parakeetLanguages.includes(language) ? [parakeet, whisper] : [whisper, parakeet];
}
export function detectModelFamily(fileName: string): CatalogModel["family"] {
  return fileName.toLowerCase().includes("parakeet") ? "parakeet" : "whisper";
}
export function modelDownloadURL(model: CatalogModel): string | undefined {
  return model.repository === "" ? undefined :
    `https://huggingface.co/${model.repository}/resolve/main/${encodeURIComponent(model.file)}`;
}
export function modelVendor(model: CatalogModel): "OpenAI Whisper" | "NVIDIA Parakeet" {
  return model.family === "whisper" ? "OpenAI Whisper" : "NVIDIA Parakeet";
}

export class ModelCatalog {
  readonly data: Catalog;
  constructor(input: unknown) { this.data = parseModelCatalog(input); }
  get models(): readonly CatalogModel[] { return this.data.models; }
  model(id: string): CatalogModel | undefined { return modelById(this.data, id); }
  recommendations(tier: HardwareTier, language: string): CatalogModel[] {
    return recommendationsFor(this.data, tier, language);
  }
}
