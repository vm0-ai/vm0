---
name: notion-illustration
description: Generate a Notion-editorial-style hand-drawn spot illustration via fal-ai/nano-banana/edit. Black brush-pen ink on white, tapered confident strokes, solid-black curly hair, solid-black pants/shoes, 3/4 face turned toward viewer with closed-eye smile and soft nose hint, open breathing body outlines, and 1-3 supporting scene props + ambient marks that frame the moment. Trigger when user says /notion-illustration, asks for a "Notion-style illustration", "Notion spot illustration", or a new piece in this hand-drawn brush-pen Notion editorial style.
---

# /notion-illustration — locked Notion-style spot illustration

This skill produces single-character spot illustrations in the Notion editorial hand-drawn brush-pen style. Loose playful sketch energy, tapered confident ink strokes, breathing-open contours, solid-black hair and pants — **plus a small supporting scene that anchors the moment in a place** (not a figure floating in white). Each invocation swaps only the **scene/activity** — every other style axis stays locked.

## Invocation flow

The user will give a **short, simple prompt** — usually just the activity (e.g. "reading", "walking the dog", "making coffee"). It is your job to **brainstorm and expand it into a rich, specific scene**. Do not ask the user to flesh it out. Do not stop to confirm. Just imagine the moment vividly and run.

For each invocation:

1. **Take the user's short prompt as the seed.** Treat it as a starting hook, not the whole brief.
2. **Brainstorm the moment.** Picture a specific time of day, a specific mood, a specific small detail that makes this scene feel *this scene* and not generic. What is the character actually doing in their hands? What's around them? What's the temperature of the moment — sleepy, focused, playful, cozy?
3. **Compose the scene** with 1-3 supporting props + 2-4 ambient marks (see playbook for inspiration, but go beyond it — make creative choices specific to this prompt). Don't crowd the figure — supporting props frame, they don't compete.
4. **Generate immediately** via the Path B recipe below. Lead the reply with the result and a one-line note on the creative choices you made (so the user can redirect if your interpretation missed).

Bias toward concrete, lived-in details: a half-drunk mug, a kicked-off shoe, a single tossed sock, a bookmark sticking out, a window cracked open. The scene should feel like the artist *was there*.

## Locked style axes (NEVER vary)

### Line quality
- Black brush-pen / ink brush on slightly textured paper
- **Tapered strokes** — thick in the middle, thin at the ends, like a real calligraphic brush
- Confident, slightly imperfect — visible pressure variation, organic wobbles, ink density shifts
- Hand-painted feel, NOT digital-clean, NOT vector, NOT marker-uniform-thickness
- Each line breathes — slight personality

### Flowing floaty gesture quality (潇洒 — critical)
Lines should have a sense of **MOTION** and **FLOW** — streamlined, airy, gestural. Each shape is **SUGGESTED by a few confident sweeping strokes**, not constructed as a careful contour with little gaps. Think *calligraphy*, not *outlining*.

**The key insight:** instead of drawing a complete outline and then adding small breaks, draw only a few gestural sweeps that *imply* the shape. WHOLE SECTIONS of the contour are simply absent — not "missing with a visible small gap" but *not drawn at all*. The viewer's eye fills in the missing 30-50% because the few strokes that ARE there carry enough information.

What this means concretely:
- **A couch is not an outline with breaks** — it's maybe 3-4 confident flowing strokes (one sweep for the back curve, one for the seat, one for an armrest) and large stretches of white where there'd "normally" be a contour
- **A body is not a closed silhouette** — it's a few flowing gestural strokes (one sweep down the back/side, one for an arm, one for a leg) leaving entire body sections unoutlined
- **Lines have a sense of MOTION** — they sweep through the space like the brush was moving fast, with momentum, almost like brush calligraphy
- **Streamlined flowing curves** — long elegant sweeps, not short careful segments
- **Floaty, light, airy** — the figure and props feel like they could lift off the page
- **Strokes carry energy** — pressure variation creates the feeling of movement frozen mid-gesture

Anti-patterns to avoid:
- ❌ Drawing a complete outline and then adding tiny "breaks" in it
- ❌ Short careful segments that connect at joints
- ❌ Geometric correctness — perfect rectangles, perfect curves, symmetric shapes
- ❌ Treating each contour as a closed shape with optional gaps
- ❌ "Cute clean cartoon" tidiness
- ❌ Lines that feel static or careful

The aesthetic to aim for: **calligraphy-meets-life-drawing** — confident sweeping brush gestures that capture the essence of a shape with minimum strokes, lots of breathing white space, energetic flow throughout.

### Open breathing outlines (applies to BOTH figure AND scene props)
**Many lines simply do not close.** This is a defining feature of the style — not a subtle touch. Every illustration should have multiple obvious places where a contour stops in midair, leaves a visible white gap, or floats independently of the shape it "should" belong to.

On the figure:
- Collar wide open, no closed neckline
- Shirt bottom does NOT seal to the pants — clear visible white gap at the waist
- Arms float as separate strokes near the body, not connected to the torso outline
- One sleeve cuff or pant cuff may end with a small visible gap
- A line in the middle of a sleeve or shirt panel may simply BREAK with white showing through, even when there's no "joint" reason for it
- Hair silhouette outer edge may have one small open spot

On scene props (just as important — props should NOT all be tidy closed shapes):
- Bed frame outline breaks at a corner, doesn't fully close
- Couch back has a small open gap where the curve "should" continue
- Nightstand legs don't fully connect to the top surface
- Pot outline has a small break
- Table edge has a tiny gap
- Furniture corners are loose, not perfectly joined

The rule of thumb: at least 3-5 obvious visible breaks across the whole illustration (figure + props combined), in spots that look natural for a brush to have lifted. The viewer's eye mentally connects the strokes — the figure and scene still read clearly, but each contour was drawn as a confident gesture, not a careful closed-shape exercise.

### Face (target: warm, inviting, facing viewer)
- 3/4 angle **turned toward the viewer** (NOT strict side profile)
- **Both eyes visible** as small upward-curved closed-smile arcs (`⌒⌒`) — closed-eye happy expression
- Nose: tiny soft hint integrated into the face — almost no protrusion, NOT a triangular bump, NOT sharp
- Mouth: small soft smile curve
- Head slightly larger than realistic, soft round cheek

### Hair
- Solid black filled silhouette with mostly bumpy organic outer edges
- Mostly solid — only ONE OR TWO very subtle internal brush separations (no busy white scribbles, no excessive gaps)
- Voluminous shoulder-length curls, drawn loosely

### Black silhouette fills
- Pants drawn as a **solid black silhouette** with slightly brushy imperfect edges (not perfectly clean)
- Shoes solid black
- Selective use only — never the shirt, never the face

### Figure proportions
- Slightly cartoony — head a bit larger than realistic
- Body loose and lightly elongated, NOT chibi, NOT abstract gesture, NOT anatomical
- Limbs feel light and floaty, drawn as quick gestures

### Scene context (NEW — always extend)
The figure should NEVER float alone in white space. Every generation includes:

- **1-3 supporting PROPS** that frame the activity. Drawn in the same loose brush-pen style as the character — same line weight, same tapered quality, same level of detail. Props are quick supporting sketches, NOT detailed background. Examples:
  - Sleeping/waking → bed with rumpled blanket + pillow, nightstand with alarm clock, slippers on floor
  - Reading → couch with curved back + visible legs, side table, lamp, mug
  - Outdoor walk → small grass tufts under feet, a tree silhouette, a bird in the sky
  - Cooking → counter line, pot/pan, small ingredient marks
  - Working → desk with laptop, mug, papers, chair with curved back
  - Pet moment → pet rendered loose in same style, possibly on furniture
  - Celebration → cake/balloon/gift, plus floating sparkles
- **2-4 ambient MARKS** in the air around the scene that signal mood/motion. Tiny in scale, never crowding:
  - Sparkles / 4-point stars (`✦ ✧ *`) — fresh air, magic moment, celebration, morning
  - Action dashes (`'  '`) near limbs — motion, stretch, swing, momentum
  - Hearts above heads — affection, comfort
  - Small sun/moon in a corner — time of day
  - Music notes — listening
  - Z's — sleep
- **Composition with the scene**: character can be slightly off-center with props arranged on one side. Generous white margins still. The scene reads as a small captured moment, not a crowded illustration.

### Composition rules
- Single primary character (occasionally two if the activity requires)
- Pure white background — NEVER add a sky/floor/wall fill
- Generous white margin all around
- NO color, NO gray fill (line/silhouette only), NO shading, NO hatching, NO border frame, NO text

### Mood
- Warm, candid, everyday — a confident artist's quick brush sketch capturing one playful moment in its setting

## SCENE BRAINSTORM PLAYBOOK

This is **inspiration, not a template**. Always go beyond these starter combos — pick details specific to the moment you're imagining.

| Activity seed | Possible props (pick 1-3) | Possible ambient marks (pick 2-4) |
|---|---|---|
| Waking up / stretching | bed + rumpled blanket + pillow, nightstand with alarm clock, slippers, kicked-off blanket on floor, half-open curtain | sun in corner, action dashes near arms, sparkles, single floating feather from pillow |
| Reading | couch with legs, side table + mug, stack of books, reading lamp, blanket draped over lap | pages-flutter mark, soft Z if dozing, sparkle, single dust mote |
| Walking a dog / pet | leash, dog or cat (loose style), small grass tufts, fire hydrant, fallen leaf | small bird overhead, action dashes near feet, paw prints, heart |
| Working / focused | desk + laptop + mug, scattered papers, chair back, sticky notes, plant on desk | floating workflow boxes, light bulb above head, sparkle, focused-eye-twinkle |
| Making coffee / kitchen | counter line, mug, kettle/french press, coffee bag, single bean | steam wisps, sparkle, small heart, drip-drop marks |
| Plant care / houseplant | plant pot, watering can, single dropped leaf, second plant in background | sparkles around plant, drifting leaf, sun, water-drop marks |
| Yoga / movement | yoga mat outline, water bottle, towel | breath marks, sparkles, small sun, calm-circle |
| Celebration | cake + candle, gift box, balloon | sparkles overhead, hearts, stars, confetti dots |
| Music / listening | headphones, phone, speaker, vinyl record | music notes, sparkles, vibration dashes |
| Cooking | pot/pan, ingredient marks, cutting board, chef knife | steam, sparkle, heart |
| Cuddling pet | pet, couch or floor cushion, pet toy | hearts, Z's, sparkle |
| Outdoor adventure | small grass tufts, tree silhouette, backpack, water bottle | bird overhead, sun, wind dashes |

**Brainstorming heuristic when stuck:**
- ONE prop that grounds the activity (the obvious one)
- ONE prop that adds personality/specificity (the unexpected one — the kicked-off shoe, the half-eaten snack, the bookmark)
- 2-3 small ambient marks for mood (sparkles, dashes, sun, music note, heart)
- ONE atmospheric detail (time of day, weather, mood signal)

## Path — image-to-image via fal-ai/nano-banana/edit

Always use the `edit` endpoint with the bundled reference anchors. Text-to-image alone misses the face angle, line tapering, and breathing breaks.

### Reference anchors (always include all three in `image_urls`)

The bundled reference PNGs are hosted on `raw.githubusercontent.com` and are directly fetchable by fal's `/edit` endpoint (correct `Content-Type: image/png` header, no redirect, no auth, no expiry). Do NOT re-host them via `cdn.vm0.io`, GitHub release assets, or base64 data URIs — all three are rejected by fal's image fetcher (signed-redirect + `application/octet-stream`).

Base path: `https://raw.githubusercontent.com/vm0-ai/vm0/main/.claude/skills/notion-illustration/`

Pass three primary anchors:

1. **`ref-locked.png`** — the canonical exemplar that already matches every style axis. PRIMARY anchor; controls overall style.
2. **`ref-anchor.png`** — face angle reference (3/4 facing viewer, both closed-smile eyes, soft integrated nose).
3. **`ref-golf.png`** OR **`ref-cat.png`** — line tapering + breathing breaks reference (golf is best for body openness, cat is best for hair texture).

The bundled `ref-scene-binoculars.png`, `ref-scene-cake.png`, `ref-scene-couch.png`, and `ref-scene-workflow.png` are scene-extension references — sub in one when its scene pattern matches the activity (grass+kneeling, multiple-character+props, furniture, floating-UI).

### Endpoint

```
POST https://queue.fal.run/fal-ai/nano-banana/edit
```

(NOT `fal.run/...` — direct fal.run is firewalled in this sandbox. `queue.fal.run` works.)

### Request body template

```json
{
  "prompt": "<see PROMPT TEMPLATE below>",
  "image_urls": [
    "https://raw.githubusercontent.com/vm0-ai/vm0/main/.claude/skills/notion-illustration/ref-locked.png",
    "https://raw.githubusercontent.com/vm0-ai/vm0/main/.claude/skills/notion-illustration/ref-anchor.png",
    "https://raw.githubusercontent.com/vm0-ai/vm0/main/.claude/skills/notion-illustration/ref-golf.png"
  ],
  "num_images": 1,
  "output_format": "png"
}
```

### Async flow

The queue endpoint is async — submit, then poll status, then fetch result:

```bash
# 1. Submit
REQ=$(curl -sS -X POST "https://queue.fal.run/fal-ai/nano-banana/edit" \
  -H "Authorization: Key $FAL_TOKEN" -H "Content-Type: application/json" \
  -d @body.json | jq -r .request_id)

# 2. Wait ~25s then fetch result
sleep 25
curl -sS "https://queue.fal.run/fal-ai/nano-banana/requests/$REQ" \
  -H "Authorization: Key $FAL_TOKEN" | jq -r '.images[0].url'
```

### PROMPT TEMPLATE (fill in `{{ACTIVITY}}` and `{{SCENE}}`)

```
Generate a single-scene spot illustration in the Notion editorial hand-drawn style shown in the reference images. Match the locked style EXACTLY.

SUBJECT — character: {{ACTIVITY}}

SCENE — environment around the character (critical, do NOT leave the figure floating in white):
{{SCENE — list 1-3 supporting props and 2-4 ambient marks. Example for "stretching after waking up":
- A loosely drawn BED behind/beside her: simple rectangular bed frame outline with a tall pillow at the head and a tossed-aside blanket draped over the side (rumpled, just-got-out-of-bed feeling)
- A small NIGHTSTAND with a SIMPLE ROUND ALARM CLOCK on top
- A pair of SLIPPERS on the floor beside her bare feet
- 2-3 tiny SPARKLE/STAR marks (small four-point asterisks ✦ ✧) in the air around her head
- 2-3 tiny ACTION DASHES near her arms suggesting the stretch motion
- A small SUN graphic in one upper corner (loose circle with a few short rays)}}

All scene props rendered in the SAME hand-drawn brush-pen style as the character — same line weight, same tapered strokes, same loose confident quality. Props should feel like quick supporting sketches, NOT detailed background — they frame the moment without crowding.

LINE QUALITY:
- Black brush-pen ink strokes with TAPERED quality (thick in the middle, thin at the ends) — calligraphic, confident, hand-painted.
- Visible pressure variation, organic wobbles, slight ink density shifts. NOT digital-clean, NOT uniform-thickness marker lines.
- Lines breathe with personality.

FLOWING FLOATY GESTURE QUALITY (潇洒 — critical):
- Each shape is SUGGESTED by a few confident SWEEPING gestural strokes, NOT constructed as a careful contour with little gaps.
- WHOLE SECTIONS of contour are simply ABSENT — not "missing with a small visible gap" but not drawn at all. The viewer's eye fills in 30-50% of the implied shape.
- A couch is 3-4 flowing sweeps (one for the back curve, one for the seat, one for an armrest) with large stretches of white where contour would "normally" be — NOT a complete outline with broken bits.
- A body is a few flowing gestural strokes (one sweep down the back/side, one for an arm, one for a leg) leaving entire body sections unoutlined — NOT a closed silhouette with little breaks.
- Lines have a sense of MOTION — they sweep through space like the brush was moving fast, with momentum, almost like calligraphy.
- Streamlined, flowing, light, FLOATY — the whole illustration feels airy.
- ANTI-PATTERNS to avoid: complete outlines with tiny "breaks", short careful segments, geometric correctness, treating each contour as a closed shape with optional gaps, static feel.
- The aesthetic: CALLIGRAPHY-MEETS-LIFE-DRAWING — confident sweeping brush gestures capturing the essence with minimum strokes and lots of breathing white space.

OPEN BREATHING OUTLINES (critical — applies to FIGURE AND SCENE PROPS):
- MANY lines simply do not close. This is the defining feature of the style — not subtle. At least 3-5 obvious visible breaks across the whole illustration.
- On the figure: collar wide open, shirt does NOT connect to the pants (visible white gap at waist), arms float as separate strokes not joined to the torso, a sleeve or pant cuff ends with a gap, sometimes a line in the middle of a panel simply breaks with white showing through.
- On the scene props: bed frame outline breaks at a corner, couch back has a small open gap, nightstand legs don't fully connect to the top, pot/cup/table outlines have small breaks, furniture corners are loose. Props should NOT all be tidy closed shapes.
- The viewer mentally connects the strokes — the figure and scene still read clearly, but each contour was drawn as a confident gesture, not a careful closed-shape exercise.

FACE:
- 3/4 angle TURNED TOWARD THE VIEWER (NOT strict side profile).
- BOTH EYES visible as small upward-curved closed-smile arcs — closed-eye happy expression, NOT dots, NOT open eyes.
- NOSE: a tiny soft hint integrated into the face, almost no protrusion. NOT triangular, NOT sharp.
- MOUTH: small soft smile curve.
- Head slightly larger than realistic, soft round cheek.

HAIR:
- Voluminous shoulder-length curly hair as a SOLID BLACK FILLED silhouette.
- Mostly solid — only ONE OR TWO very subtle internal brush separations. NO busy white scribbles, NO excessive gaps.
- Bumpy organic outer edge.

BLACK SILHOUETTE FILLS:
- Loose pants drawn as SOLID BLACK silhouette with slightly brushy imperfect edges.
- Shoes solid black (or barefoot small outlines).
- Shirt outline only with breathing breaks.

PROPORTIONS:
- Slightly cartoony — head a bit larger than realistic.
- Body loose and lightly elongated, limbs light and floaty.
- Quick gesture feel, NOT careful anatomical contour.

COMPOSITION:
- Character is the focal point, scene props arranged around her without crowding.
- Pure white background.
- Generous white margins, balanced composition (character can be slightly off-center).
- NO color, NO gray fill (line/silhouette only), NO shading, NO hatching, NO border frame, NO text.

MOOD: warm, candid, everyday — a quiet captured moment in its setting.

Match the locked exemplar style precisely. Scene props should follow the look of the bundled scene references (cake/binoculars/couch/workflow). Do NOT copy any text or UI from the references.
```

## Iteration playbook

If the first output misses on a specific axis, the proven correction prompts:

| Issue | Correction (i2i with prior output as anchor) |
|---|---|
| Figure floating alone, no scene | "Add scene context — 1-3 supporting props that frame the activity (specify which), plus 2-4 small ambient marks (sparkles, action dashes). All in the same brush-pen style." |
| Scene props too detailed / crowding | "Simplify the scene — fewer props, looser brush sketches, more white space around the character." |
| Face turned to strict profile | "Turn the face to 3/4 angle facing the viewer — show BOTH closed-smile eye curves, soften the nose to a tiny integrated hint." |
| Nose too triangular / sharp | "Replace the pointed triangular nose with a soft gentle rounded curve barely interrupting the profile — almost integrated into the face line." |
| Lines too uniform / digital | "Redraw with tapered brush-pen strokes (thick middle, thin ends) and visible hand-painted ink texture — pressure variation, slight organic wobbles." |
| Body lines all closed loops | "Add visible white BREAKS in body outlines — collar wide open, waist completely unsealed, arm strokes float separately from torso." |
| Scene prop outlines too tidy / all closed | "Break the scene prop contours too — bed frame doesn't close at a corner, couch back has an open gap, nightstand legs don't fully meet the top. Furniture and props should have at least 1-2 visible breaks each, same hand-drawn breathing quality as the figure." |
| Not enough overall breaks | "More visible white breaks across the whole illustration — at least 3-5 obvious places where contours simply stop in midair. This is a defining feature of the style, not a subtle touch." |
| Hair too many white gaps | "Reduce internal white gaps in hair — mostly solid black with only one or two subtle brush separations." |
| Feels too clean / designed | "Looser playful 30-second-doodle quality, larger head proportions, brushy imperfect edges on the black silhouettes." |
| Lines feel stiff / static (not 潇洒, not floaty) | "More FLOWING FLOATY gestural quality — each shape SUGGESTED by 3-4 confident sweeping brush strokes, NOT drawn as a complete outline with small breaks. WHOLE SECTIONS of contour simply absent (the back of the couch, half of one body side). Calligraphy-meets-life-drawing energy: minimum strokes, lots of breathing white space, motion and flow throughout. Viewer's eye fills in 30-50% of implied shape." |

## Cost & timing
- ~25s per generation via the queue endpoint
- ~$0.04 per image (fal-ai/nano-banana/edit pricing)
