import { z } from "zod";

/** Advisory categories only. Audio measurements and device identity never leave the capture utility. */
export const audioQualityNoticeSchema = z.enum(["very_quiet", "clipping", "background_noise", "limited_bandwidth"]);
export type AudioQualityNotice = z.infer<typeof audioQualityNoticeSchema>;
