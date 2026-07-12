import { createHash } from "node:crypto";
import type { ExtractedSection } from "./extract-sections.js";

export interface ExistingSectionHash {
  paperId: string;
  sectionId: string;
  contentHash: string;
}

export interface SectionToEmbed extends ExtractedSection {
  paperId: string;
  contentHash: string;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function findChangedSections(
  paperId: string,
  extracted: ExtractedSection[],
  existingHashes: ExistingSectionHash[],
): SectionToEmbed[] {
  const existingMap = new Map(
    existingHashes.filter((e) => e.paperId === paperId).map((e) => [e.sectionId, e.contentHash]),
  );
  const changed: SectionToEmbed[] = [];
  for (const section of extracted) {
    const contentHash = hashContent(section.content);
    if (existingMap.get(section.sectionId) !== contentHash) {
      changed.push({ ...section, paperId, contentHash });
    }
  }
  return changed;
}
