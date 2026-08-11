import { createHash } from 'node:crypto';
import type { BlockCategoryId } from './types.js';

/**
 * Single source of truth for what gets blocked. Every platform (relay
 * validation, desktop daemon, Android) imports this file (TS) or a generated
 * mirror of it (Kotlin/Swift can't import TS directly — see DECISIONS.md for
 * how those stay in sync). Domains are matched as exact-or-subdomain.
 */
export interface BlockCategory {
  id: BlockCategoryId;
  label: string;
  domains: string[];
  /** Windows process image names / macOS bundle IDs / package-name fragments for native app blocking. */
  processNames: string[];
  /**
   * Substrings matched case-insensitively against a browser window's title
   * (`tasklist /v`'s Window Title column on Windows). Exists because
   * hosts-file DNS blocking only stops *new* lookups — a tab that's already
   * open and connected, or one loading a CDN hostname never in `domains`
   * (YouTube's actual video traffic goes to dynamically-named
   * `*.googlevideo.com` hosts that can't be enumerated ahead of time, not
   * `youtube.com` itself), keeps working regardless of the hosts file.
   * A browser's top-level window title reflects its foreground tab, so this
   * catches "the blocked site is the tab someone's actually looking at" —
   * the case that actually gets reported as "didn't get blocked" — not
   * every background tab. Deliberately excludes short/common-English-word
   * brand names (e.g. "X", "Origin", "Vice", "Signal") that would false-positive
   * on unrelated window titles and kill an innocent browser window.
   */
  titleKeywords: string[];
}

export const BLOCK_CATEGORIES: BlockCategory[] = [
  {
    id: 'social',
    label: 'Social',
    domains: [
      'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me', 'messenger.com',
      'instagram.com', 'threads.net', 'twitter.com', 'x.com', 't.co',
      'tiktok.com', 'vm.tiktok.com', 'snapchat.com', 'reddit.com', 'redd.it',
      'old.reddit.com', 'pinterest.com', 'pin.it', 'linkedin.com', 'lnkd.in',
      'tumblr.com', 'discord.com', 'discordapp.com', 'discord.gg',
      'whatsapp.com', 'web.whatsapp.com', 'telegram.org', 't.me',
      'wechat.com', 'weibo.com', 'vk.com', 'mastodon.social', 'bsky.app',
      'bere.al', 'bereal.com', 'clubhouse.com', 'nextdoor.com', 'quora.com',
      'tinder.com', 'bumble.com', 'hinge.co', 'grindr.com', 'meetup.com',
      'imgur.com', 'flickr.com', '9gag.com', 'buzzfeed.com', 'vine.co',
      'periscope.tv', 'kik.com', 'line.me', 'viber.com', 'signal.org',
    ],
    processNames: ['Discord.exe', 'Discord', 'Slack.exe'],
    titleKeywords: [
      'facebook', 'instagram', 'threads.net', 'tiktok', 'snapchat', 'reddit',
      'pinterest', 'linkedin', 'tumblr', 'discord', 'whatsapp', 'telegram',
      'wechat', 'weibo', 'mastodon', 'bluesky', 'bereal', 'nextdoor', 'quora',
      'tinder', 'bumble', 'hinge', 'grindr', 'imgur', 'flickr', '9gag', 'buzzfeed',
    ],
  },
  {
    id: 'games',
    label: 'Games',
    domains: [
      'steampowered.com', 'steamcommunity.com', 'store.steampowered.com',
      'epicgames.com', 'unrealengine.com', 'battle.net', 'blizzard.com',
      'riotgames.com', 'leagueoflegends.com', 'valorant.com',
      'roblox.com', 'rbxcdn.com', 'xbox.com', 'account.xbox.com',
      'playstation.com', 'my.playstation.com', 'nintendo.com',
      'ea.com', 'origin.com', 'ubisoft.com', 'ubi.com', 'ubisoftconnect.com',
      'gog.com', 'itch.io', 'twitch.tv', 'kongregate.com', 'miniclip.com',
      'poki.com', 'crazygames.com', 'friv.com', 'agar.io', 'krunker.io',
      'coolmathgames.com', 'addictinggames.com', 'y8.com', 'armorgames.com',
      'newgrounds.com', 'chess.com', 'lichess.org', 'hearthstone.com',
      'minecraft.net', 'fortnite.com', 'ea.com',
    ],
    processNames: [
      'steam.exe', 'Steam.exe', 'EpicGamesLauncher.exe', 'Battle.net.exe',
      'Discord.exe', 'RiotClientServices.exe', 'LeagueClient.exe',
      'RobloxPlayerBeta.exe', 'Origin.exe', 'EADesktop.exe',
      'UbisoftConnect.exe', 'upc.exe', 'GalaxyClient.exe', 'javaw.exe',
      'Minecraft.exe', 'FortniteClient-Win64-Shipping.exe',
      'Steam', 'Battle.net', 'Epic Games Launcher',
    ],
    titleKeywords: [
      'steam', 'epic games', 'battle.net', 'roblox', 'playstation', 'nintendo',
      'ubisoft', 'itch.io', 'kongregate', 'miniclip', 'crazygames', 'chess.com',
      'lichess', 'hearthstone', 'minecraft', 'fortnite', 'league of legends', 'valorant',
    ],
  },
  {
    id: 'video',
    label: 'Video',
    domains: [
      'youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com',
      'netflix.com', 'hulu.com', 'primevideo.com', 'disneyplus.com',
      'hbomax.com', 'max.com', 'twitch.tv', 'vimeo.com', 'dailymotion.com',
      'crunchyroll.com', 'peacocktv.com', 'paramountplus.com', 'plex.tv',
      'bilibili.com', 'nicovideo.jp',
    ],
    processNames: ['Netflix.exe'],
    titleKeywords: [
      'youtube', 'netflix', 'hulu', 'prime video', 'disney+', 'disneyplus',
      'hbo max', 'twitch', 'vimeo', 'dailymotion', 'crunchyroll', 'peacock',
      'paramount+', 'plex', 'bilibili', 'nicovideo',
    ],
  },
  {
    id: 'news',
    label: 'News/Forums',
    domains: [
      'news.ycombinator.com', 'reddit.com', 'digg.com', 'slashdot.org',
      'cnn.com', 'bbc.com', 'nytimes.com', 'theguardian.com', 'foxnews.com',
      'washingtonpost.com', 'huffpost.com', 'buzzfeednews.com', 'vice.com',
      'theverge.com', 'techcrunch.com', 'engadget.com', 'arstechnica.com',
      'medium.com', 'substack.com', 'forums.somethingawful.com', '4chan.org',
      'boards.4chan.org',
    ],
    processNames: [],
    titleKeywords: [
      'hacker news', 'techcrunch', 'ars technica', 'the verge', 'engadget',
      'washington post', 'new york times', 'buzzfeed news', 'huffpost',
      'cnn', 'bbc', 'fox news', 'the guardian', 'medium', 'substack', '4chan',
    ],
  },
];

/** SHA-256 of the canonical JSON of BLOCK_CATEGORIES, checked on load by every client. */
export function blocklistHash(categories: BlockCategory[] = BLOCK_CATEGORIES): string {
  const canonical = JSON.stringify(
    categories.map((c) => ({
      id: c.id,
      label: c.label,
      domains: [...c.domains].sort(),
      processNames: [...c.processNames].sort(),
    })),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function validateBlocklist(categories: BlockCategory[] = BLOCK_CATEGORIES): void {
  const ids = new Set<string>();
  for (const c of categories) {
    if (ids.has(c.id)) throw new Error(`duplicate blocklist category id: ${c.id}`);
    ids.add(c.id);
    if (c.domains.length === 0 && c.processNames.length === 0) {
      throw new Error(`blocklist category ${c.id} has no domains or processes`);
    }
    for (const d of c.domains) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) {
        throw new Error(`blocklist category ${c.id} has malformed domain: ${d}`);
      }
    }
  }
}

export function getCategory(id: BlockCategoryId): BlockCategory {
  const found = BLOCK_CATEGORIES.find((c) => c.id === id);
  if (!found) throw new Error(`unknown block category: ${id}`);
  return found;
}

export function domainsForCategories(ids: BlockCategoryId[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    for (const d of getCategory(id).domains) set.add(d);
  }
  return [...set];
}

export function processNamesForCategories(ids: BlockCategoryId[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    for (const p of getCategory(id).processNames) set.add(p);
  }
  return [...set];
}

export function titleKeywordsForCategories(ids: BlockCategoryId[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    for (const k of getCategory(id).titleKeywords) set.add(k.toLowerCase());
  }
  return [...set];
}
