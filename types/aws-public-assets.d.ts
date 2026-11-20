declare module 'beter:public-assets' {
  export const assets: Record<string, {body: string; contentType: string; isBase64Encoded?: boolean}>;
}
