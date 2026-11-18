declare module 'markdown-it-texmath' {
  interface TexmathOptions {
    engine: unknown;
    delimiters?: string;
    katexOptions?: Record<string, unknown>;
  }

  const texmath: (md: unknown, options: TexmathOptions) => void;
  export default texmath;
}
