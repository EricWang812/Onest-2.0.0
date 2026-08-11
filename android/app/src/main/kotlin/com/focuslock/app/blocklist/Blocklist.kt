package com.focuslock.app.blocklist

/**
 * Hand-ported mirror of shared/src/blocklist.ts. Kotlin can't import a TS
 * module, so this list must be kept in sync by hand — see DECISIONS.md for
 * the "single source of truth" tradeoff this creates. Package-name
 * fragments below are matched as substrings against the foreground
 * package name (see accessibility/BlockAccessibilityService.kt), which is
 * Android's equivalent of the desktop's process-name matching.
 */
enum class BlockCategory(val id: String, val label: String) {
    SOCIAL("social", "Social"),
    GAMES("games", "Games"),
    VIDEO("video", "Video"),
    NEWS("news", "News/Forums"),
}

object Blocklist {
    val domains: Map<BlockCategory, List<String>> = mapOf(
        BlockCategory.SOCIAL to listOf(
            "facebook.com", "m.facebook.com", "fb.com", "fb.me", "messenger.com",
            "instagram.com", "threads.net", "twitter.com", "x.com", "t.co",
            "tiktok.com", "vm.tiktok.com", "snapchat.com", "reddit.com", "redd.it",
            "old.reddit.com", "pinterest.com", "pin.it", "linkedin.com", "lnkd.in",
            "tumblr.com", "discord.com", "discordapp.com", "discord.gg",
            "whatsapp.com", "web.whatsapp.com", "telegram.org", "t.me",
            "wechat.com", "weibo.com", "vk.com", "mastodon.social", "bsky.app",
            "bereal.com", "clubhouse.com", "nextdoor.com", "quora.com",
            "tinder.com", "bumble.com", "hinge.co", "grindr.com", "meetup.com",
            "imgur.com", "flickr.com", "9gag.com", "buzzfeed.com",
        ),
        BlockCategory.GAMES to listOf(
            "steampowered.com", "steamcommunity.com", "store.steampowered.com",
            "epicgames.com", "unrealengine.com", "battle.net", "blizzard.com",
            "riotgames.com", "leagueoflegends.com", "valorant.com",
            "roblox.com", "rbxcdn.com", "xbox.com", "account.xbox.com",
            "playstation.com", "my.playstation.com", "nintendo.com",
            "ea.com", "origin.com", "ubisoft.com", "ubi.com", "ubisoftconnect.com",
            "gog.com", "itch.io", "twitch.tv", "kongregate.com", "miniclip.com",
            "poki.com", "crazygames.com", "coolmathgames.com", "y8.com",
            "newgrounds.com", "chess.com", "lichess.org", "minecraft.net", "fortnite.com",
        ),
        BlockCategory.VIDEO to listOf(
            "youtube.com", "m.youtube.com", "youtu.be", "netflix.com", "hulu.com",
            "primevideo.com", "disneyplus.com", "hbomax.com", "max.com", "twitch.tv",
            "vimeo.com", "crunchyroll.com", "peacocktv.com", "plex.tv",
        ),
        BlockCategory.NEWS to listOf(
            "news.ycombinator.com", "reddit.com", "digg.com", "slashdot.org",
            "cnn.com", "bbc.com", "nytimes.com", "theguardian.com", "foxnews.com",
            "washingtonpost.com", "huffpost.com", "vice.com", "theverge.com",
            "techcrunch.com", "medium.com", "substack.com",
        ),
    )

    // Package-name substrings for native app blocking (VPN handles domains;
    // the accessibility service handles native apps that don't route through DNS).
    val packageFragments: Map<BlockCategory, List<String>> = mapOf(
        BlockCategory.SOCIAL to listOf(
            "com.facebook.katana", "com.facebook.orca", "com.instagram.android",
            "com.twitter.android", "com.zhiliaoapp.musically", "com.snapchat.android",
            "com.reddit.frontpage", "com.pinterest", "com.linkedin.android",
            "com.tumblr", "com.discord", "com.whatsapp", "org.telegram.messenger",
        ),
        BlockCategory.GAMES to listOf(
            "com.valvesoftware.steam", "com.epicgames.portal", "com.blizzard.wtcg.hearthstone",
            "com.riotgames", "com.roblox.client", "com.discord", "com.ea.gp.",
            "com.ubisoft.uplay", "com.mojang.minecraftpe", "com.epicgames.fortnite",
        ),
        BlockCategory.VIDEO to listOf(
            "com.google.android.youtube", "com.netflix.mediaclient", "com.hulu.plus",
            "com.amazon.avod.thirdpartyclient", "com.disney.disneyplus", "tv.twitch.android.app",
        ),
        BlockCategory.NEWS to listOf(
            "com.reddit.frontpage", "com.cnn.mobile.android.phone", "com.bbc.news",
        ),
    )

    fun domainsFor(categories: Set<String>): Set<String> =
        domains.filterKeys { it.id in categories }.values.flatten().toSet()

    fun packageFragmentsFor(categories: Set<String>): Set<String> =
        packageFragments.filterKeys { it.id in categories }.values.flatten().toSet()
}

/** Never null-routed / never blocked, regardless of category selection. */
val NEVER_BLOCK_DOMAINS = setOf("localhost", "connectivitycheck.gstatic.com", "clients3.google.com")
