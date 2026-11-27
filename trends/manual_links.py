"""Research links Max opens by hand, for the sources with no free official API.

TikTok Creative Center has no public API, and Reddit's API needs approval this project doesn't have. Automating
either would mean scraping, which their terms forbid. So the collector only builds links to open in a browser;
it never fetches them. Anything found that way is added through the dashboard's manual form, which runs the
same niche gate, and is labelled manual (never counted as evidence by itself).
"""
import urllib.parse

TIKTOK = "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en"


def for_profile(p):
    geo = p["geo"][0]
    terms = p["anchors"][:3]
    links = [{"source": "tiktok_creative_center", "label": "TikTok Creative Center: trending hashtags (filter by "
              f"country {geo} and an industry near '{p['category']}')", "url": TIKTOK}]
    for t in terms:
        links.append({"source": "google_trends_explore", "label": f"Google Trends, last 7 days: {t}",
                      "url": "https://trends.google.com/trends/explore?" + urllib.parse.urlencode(
                          {"date": "now 7-d", "geo": geo, "q": t})})
        links.append({"source": "reddit_search", "label": f"Reddit, top this week: {t}",
                      "url": "https://www.reddit.com/search/?" + urllib.parse.urlencode({"q": t, "sort": "top", "t": "week"})})
    return links


def all_links(profiles):
    return {p["key"]: for_profile(p) for p in profiles}
