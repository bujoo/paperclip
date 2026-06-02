# AI Intelligence Digest Pipeline Architecture

**Purpose**: Autonomous daily collection, synthesis, and distribution of AI developments to ContextHub circles.

**Status**: Architecture phase (implementation starting)  
**Owner**: Researcher (Knowledge Curator)

---

## System Overview

```
┌─ Source Collectors ─┬─ YouTube (yt-dlp)
│                     ├─ RSS/Blogs (feedparser)
│                     └─ arXiv (feedparser)
│
├─ Raw Content Store ────→ /tmp/ld_raw/2026-06-02/
│
├─ Digest Synthesizer ─── LLM (Hermes API or llama.cpp)
│                     ├─ Summarization
│                     ├─ Circle routing (Eng/Strategy/Product/Marketing)
│                     └─ Insight tagging
│
├─ Structured Digest ─────→ /tmp/ld_digest/2026-06-02.json + .md
│
├─ Distributor ─────────── Creates Paperclip issues per circle
│
└─ Cron Schedule ─────────→ 07:00 collect | 07:30 synthesize | 08:00 distribute
```

---

## Component 1: Source Collector (`collect.py`)

### Purpose
Fetch raw content from all configured sources. Output structured JSON for each source.

### Sources

| Source | Type | Tool | API/Feed | Frequency |
|---|---|---|---|---|
| Two Minute Papers | YouTube | yt-dlp | Channel ID | Daily (latest) |
| Andrej Karpathy | YouTube | yt-dlp | Channel ID | Weekly |
| Hugging Face Spaces | YouTube | yt-dlp | Channel ID | Ad-hoc |
| Important AI | RSS/Blog | feedparser | feed URL | Daily |
| Gradient Flow | RSS/Blog | feedparser | feed URL | Daily |
| BAIR Blog | RSS/Blog | feedparser | feed URL | Weekly |
| OpenAI Blog | RSS/Blog | feedparser | feed URL | Weekly |
| DeepMind Blog | RSS/Blog | feedparser | feed URL | Weekly |
| arXiv CS.AI | RSS | feedparser | feed URL | Daily |
| arXiv CS.LG | RSS | feedparser | feed URL | Daily |
| Hugging Face Blog | RSS/Blog | feedparser | feed URL | Weekly |

### Output Schema

```json
{
  "source_id": "two-minute-papers",
  "source_type": "youtube",
  "fetch_timestamp": "2026-06-02T07:05:00Z",
  "items": [
    {
      "id": "yt-xyz123",
      "title": "Transformers in 2026 — A Retrospective",
      "url": "https://youtube.com/watch?v=xyz123",
      "published": "2026-06-01T10:00:00Z",
      "content": "Transcript text (first 2000 chars)",
      "metadata": {
        "channel": "Two Minute Papers",
        "duration": "8:45",
        "views": 150000
      }
    }
  ],
  "error": null
}
```

### Configuration

```python
SOURCES = {
    "two-minute-papers": {
        "type": "youtube",
        "channel_id": "UCltqaXnRyp2R3w4pTn1t-Mw",
        "limit": 1
    },
    "important-ai": {
        "type": "rss",
        "url": "https://importantai.com/feed",
        "limit": 5
    },
    "arxiv-cs-ai": {
        "type": "rss",
        "url": "http://export.arxiv.org/rss/cs.AI",
        "limit": 10
    }
}
```

### Implementation Sketch

```python
# collect.py
import feedparser
from yt_dlp import YoutubeDL
import json
from datetime import datetime
import os

def collect_youtube(channel_id, limit=1):
    ydl_opts = {'quiet': True, 'extract_flat': 'in_playlist'}
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/channel/{channel_id}/videos", download=False)
        entries = info.get('entries', [])[:limit]
        items = []
        for e in entries:
            items.append({
                'id': f"yt-{e['id']}",
                'title': e['title'],
                'url': e['url'],
                'published': e.get('upload_date'),
                'content': get_transcript(e['id'])  # TODO: implement
            })
        return items

def collect_rss(url, limit=5):
    feed = feedparser.parse(url)
    items = []
    for entry in feed.entries[:limit]:
        items.append({
            'id': entry.get('id', entry['link']),
            'title': entry['title'],
            'url': entry['link'],
            'published': entry.get('published'),
            'content': entry.get('summary', '')[:2000]
        })
    return items

def main():
    results = {}
    for source_id, config in SOURCES.items():
        try:
            if config['type'] == 'youtube':
                items = collect_youtube(config['channel_id'], config['limit'])
            elif config['type'] == 'rss':
                items = collect_rss(config['url'], config['limit'])
            results[source_id] = {'items': items, 'error': None}
        except Exception as e:
            results[source_id] = {'items': [], 'error': str(e)}
    
    # Write output
    os.makedirs('/tmp/ld_raw/2026-06-02', exist_ok=True)
    with open(f'/tmp/ld_raw/{date}.json', 'w') as f:
        json.dump(results, f, indent=2)
```

---

## Component 2: Digest Synthesizer (`synthesize.py`)

### Purpose
Analyze raw content, generate insights, route to circles, tag by relevance.

### Input
- Raw content from `/tmp/ld_raw/2026-06-02.json`
- Circle definitions (which topics go where)
- Tagging ontology

### Processing

**Step 1: Parse & Extract**
- Load raw JSON
- For each item: extract title + content (first 1000 chars)

**Step 2: Circle Routing**
- Classify item → (Engineering | Strategy | Product | Marketing)
- Use simple rules (keyword matching) or LLM

**Step 3: Insight Generation**
- Use LLM: "Summarize in 3 sentences for product engineers: [content]"
- Temperature: 0.7, max_tokens: 150

**Step 4: Tagging**
- Extract tags: (GPU, Transformer, Safety, Evaluation, etc.)
- Use predefined taxonomy

### Output Schema

```json
{
  "date": "2026-06-02",
  "generated_at": "2026-06-02T07:32:00Z",
  "insights": [
    {
      "rank": 1,
      "source": "two-minute-papers",
      "title": "Transformers in 2026 — A Retrospective",
      "url": "https://youtube.com/watch?v=xyz123",
      "circles": ["Engineering", "Strategy"],
      "insight": "This retrospective covers 10 years of transformer evolution, focusing on efficiency gains (40% compute reduction in latest models) and new architectures.",
      "tags": ["Transformer", "Efficiency", "Architecture"],
      "relevance_score": 0.92
    }
  ]
}
```

### Implementation Sketch

```python
# synthesize.py
import json
import requests
from datetime import datetime

CIRCLE_RULES = {
    'Engineering': ['model', 'training', 'inference', 'optimization', 'GPU', 'compute'],
    'Strategy': ['roadmap', 'trend', 'evaluation', 'benchmark', 'safety'],
    'Product': ['feature', 'user', 'experience', 'design', 'accessibility'],
    'Marketing': ['announcement', 'release', 'milestone', 'adoption', 'community']
}

TAGS = ['Transformer', 'Efficiency', 'Safety', 'Evaluation', 'GPU', 'Inference', 
        'Training', 'Architecture', 'Benchmark', 'Dataset']

def classify_circles(text):
    circles = []
    text_lower = text.lower()
    for circle, keywords in CIRCLE_RULES.items():
        if any(kw in text_lower for kw in keywords):
            circles.append(circle)
    return circles or ['Strategy']  # default to Strategy

def generate_insight(title, content, circle):
    prompt = f"Summarize in 3 sentences for {circle}: {title}\n\n{content[:1000]}"
    response = requests.post(
        'http://localhost:3100/api/llm/complete',
        json={'prompt': prompt, 'max_tokens': 150, 'temperature': 0.7}
    )
    return response.json()['text']

def extract_tags(text):
    tags = []
    text_lower = text.lower()
    for tag in TAGS:
        if tag.lower() in text_lower:
            tags.append(tag)
    return tags or ['General']

def main():
    with open('/tmp/ld_raw/2026-06-02.json') as f:
        raw = json.load(f)
    
    insights = []
    rank = 1
    
    for source_id, data in raw.items():
        for item in data['items'][:5]:  # top 5 per source
            circles = classify_circles(item['title'] + ' ' + item['content'])
            insight_text = generate_insight(item['title'], item['content'], circles[0])
            tags = extract_tags(item['content'])
            
            insights.append({
                'rank': rank,
                'source': source_id,
                'title': item['title'],
                'url': item['url'],
                'circles': circles,
                'insight': insight_text,
                'tags': tags,
                'relevance_score': 0.85  # TODO: compute real score
            })
            rank += 1
    
    # Write output
    with open('/tmp/ld_digest/2026-06-02.json', 'w') as f:
        json.dump({'date': '2026-06-02', 'insights': insights}, f, indent=2)
```

---

## Component 3: Distributor (`distribute.py`)

### Purpose
Create Paperclip issues for each insight, routed to circle leads.

### Mapping
- Engineering insights → Tech Lead
- Strategy insights → Circle Rep (general)
- Product insights → Product Manager
- Marketing insights → Growth Lead

### Issue Template

```
Title: [L&D Insight] {insight_title}
Description:
## {insight_title}

**Source**: {source}  
**Tags**: {tags}

{insight_3_sentences}

**Link**: {url}

---
This insight was automatically generated by the AI Intelligence Digest Pipeline.
Circle: {circles[0]}
Relevance: {relevance_score}%
```

### Implementation Sketch

```python
# distribute.py
import json
import requests

CIRCLE_MAPPING = {
    'Engineering': '322d0092',  # Tech Lead
    'Strategy': '322d0092',     # Circle Rep
    'Product': '9adc6c20',      # Product Manager
    'Marketing': 'c8cd3e0c'     # Growth Lead
}

def create_paperclip_issue(insight, owner_id):
    url = 'http://localhost:3100/api/issues'
    payload = {
        'title': f"[L&D Insight] {insight['title'][:60]}",
        'description': f"{insight['insight']}\n\n**Source**: {insight['source']}\n**Link**: {insight['url']}",
        'assigneeAgentId': owner_id,
        'priority': 'low',
        'status': 'backlog'
    }
    response = requests.post(url, json=payload)
    return response.json()

def main():
    with open('/tmp/ld_digest/2026-06-02.json') as f:
        digest = json.load(f)
    
    for insight in digest['insights']:
        primary_circle = insight['circles'][0]
        owner_id = CIRCLE_MAPPING.get(primary_circle)
        if owner_id:
            issue = create_paperclip_issue(insight, owner_id)
            print(f"✓ Created issue {issue['identifier']} for {primary_circle}")
```

---

## Component 4: Cron Schedule

### Option A: Hermes Cron Job

```yaml
# .hermes/cron/ai-digest-pipeline.yaml
schedule: "0 7 * * *"  # 07:00 daily
tasks:
  - name: collect
    command: "python3 /opt/ld/collect.py"
    timeout: 300
  - name: synthesize
    command: "python3 /opt/ld/synthesize.py"
    timeout: 600
    depends_on: collect
  - name: distribute
    command: "python3 /opt/ld/distribute.py"
    timeout: 300
    depends_on: synthesize
```

### Option B: Systemd Timer

```ini
# /etc/systemd/system/ld-digest.timer
[Unit]
Description=AI Digest Pipeline
After=network.target

[Timer]
OnCalendar=daily
OnCalendar=*-*-* 07:00:00
Persistent=true

[Install]
WantedBy=timers.target

# /etc/systemd/system/ld-digest.service
[Unit]
Description=AI Digest Pipeline Service
After=network.target

[Service]
Type=oneshot
ExecStart=/opt/ld/run.sh
User=paperclip
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## Deployment Path

### Phase 1: Proof of Concept (This Week)
- [ ] Collector: 2-3 sources working (YouTube, arXiv, RSS)
- [ ] Synthesizer: Basic stub (keyword routing, mock insights)
- [ ] Distributor: Create 1 test issue per circle
- [ ] Manual trigger: `python3 /opt/ld/collect.py`

### Phase 2: Integration (Next Week)
- [ ] Add LLM-based summarization (via Hermes API)
- [ ] Expand sources to full list (10 sources)
- [ ] Set up cron schedule (Hermes or systemd)
- [ ] Test full pipeline: 07:00-08:00 daily

### Phase 3: Scaling (Week 3+)
- [ ] Add filtering/deduplication (avoid same insight twice)
- [ ] Add human review step (optional: validate insights before creating issues)
- [ ] Add dashboard: track digest quality, circle engagement
- [ ] Archive digests: searchable history in NotebookLM

---

## Success Criteria

- [ ] Pipeline runs daily without human intervention
- [ ] By 08:30, digest issues appear in all 4 circles
- [ ] Each insight is: <150 words, actionable, properly tagged
- [ ] Handles errors gracefully (missing feeds, API errors, etc.)
- [ ] Logs recorded to `/opt/ld/logs/YYYY-MM-DD.log`

---

## Dependencies

- `yt-dlp` — YouTube transcript fetching
- `feedparser` — RSS/Atom parsing
- `requests` — HTTP calls to Paperclip API + LLM
- `python-dateutil` — Date handling
- Hermes API access (for LLM synthesis)

Install:
```bash
pip install yt-dlp feedparser requests python-dateutil
```

---

## Next Steps

1. **This commit**: Architecture doc (DONE)
2. **Next**: Build `collect.py` with 3 test sources
3. **Then**: Build `synthesize.py` with LLM stub
4. **Then**: Build `distribute.py` + test
5. **Then**: Set up cron + validate daily run

---

**Maintained By**: Researcher (Knowledge Curator)  
**Last Updated**: 2026-06-02  
**Status**: Architecture approved, implementation starting
