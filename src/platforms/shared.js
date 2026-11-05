export const hostMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

export const uniqueHttpUrls = (urls) => [...new Set(urls)].filter((u) => /^https?:\/\//.test(u));
