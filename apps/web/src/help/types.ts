export interface HelpHeading {
  id: string;
  text: string;
  level: number;
}

export interface HelpDoc {
  slug: string;
  title: string;
  category: string;
  path: string;
  html: string;
  plainText: string;
  headings: HelpHeading[];
}
