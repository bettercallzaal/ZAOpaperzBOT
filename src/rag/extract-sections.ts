import * as cheerio from "cheerio";

export interface ExtractedSection {
  sectionId: string;
  title: string;
  content: string;
  url: string;
}

export function extractSections(html: string, baseUrl: string): ExtractedSection[] {
  const $ = cheerio.load(html);
  const sections: ExtractedSection[] = [];
  let positionalIndex = 0;

  $("section").each((_, el) => {
    const $section = $(el);
    const heading = $section.find("h2").first();
    if (heading.length === 0) return;

    positionalIndex += 1;
    const title = heading.text().trim();
    const content = $section.text().replace(/\s+/g, " ").trim();
    const realId = $section.attr("id");
    const sectionId = realId || `section-${positionalIndex}`;
    const url = realId ? `${baseUrl}#${realId}` : baseUrl;

    sections.push({ sectionId, title, content, url });
  });

  return sections;
}
