# 宠物素材与生成记录

工具模式：内置 `image_gen`，透明背景；猫咪按用户补充照片编辑微调，狗狗按用户照片生成。原始输出保留在 Codex 生成目录，发行使用下列项目内素材。渲染器通过 SVG viewBox 读取精灵帧，保留 PNG 原始透明通道，没有离线重绘或压平背景。

| 形象 | 素材 |
| --- | --- |
| grey-cat-pixel.png | [PNG](../../src/pet/assets/grey-cat-pixel.png) |
| grey-cat-comic.png | [PNG](../../src/pet/assets/grey-cat-comic.png) |
| apricot-dog-pixel.png | [PNG](../../src/pet/assets/apricot-dog-pixel.png) |
| apricot-dog-comic.png | [PNG](../../src/pet/assets/apricot-dog-comic.png) |

每张图 4 列 × 3 行，12 个姿态：正面、左侧、背面、右侧、睡眠两帧、打盹两帧、翘尾两帧、伸懒腰、探头。绘制存在跨等分线的边缘，因此使用 [帧边界](../../src/pet/assets/pet-frames.json) 明确截取每个完整姿态。

## 最终提示词

### grey-cat-pixel.png

```text
Edit the attached PIXEL sprite sheet (image 1), preserving its 4 columns x 3 rows, twelve poses, crisp chunky retro pixel style and transparent background. Use the three new photo references (images 2-4) to make this exactly the user's grey and white cat, not a generic kitten. Distinctive very LARGE tall pointed ears, narrow angular slender Devon Rex-like face with broad cheekbones, very short velvety grey fur (not fluffy), slender neck/body, very long fine white whiskers suggested by a few pixels, big pale yellow-green irises and dark pupils, small pink triangular nose. White blaze is narrow between eyes, widens over muzzle, white chin and broad white chest/bib, white socks on grey forelegs. Grey tail with GREY tip, no invented white tail tip, no stripes. Preserve appealing small-pixel charm and simple flat limited colors. Increase ear height and face slenderness, make the green irises readable. Use medium neutral soft grey not blue and not brown. No accessories, no toy, no car, no people, no text, no floor.
Use EXACT equal 4x3 grid and generous padding in every cell, each sprite must entirely fit within its own cell and must not touch grid boundaries. Row1 front sitting; standing left; standing rear; standing right. Row2 curled asleep; same curled slightly breathing; sitting dozing half-open eyes; sitting head nodded eyes closed. Row3 sitting tail curled LEFT; same sitting tail curled RIGHT (two visibly different tail poses); stretching forepaws forward rump raised; ONLY front head with two paws for edge-peeking. Preserve consistent physical scale and identity. True transparent alpha, no border, no drop shadow, no checkerboard.
```

### grey-cat-comic.png

```text
Refine the first image, an illustrated cartoon cat sprite sheet, to resemble the cat in photos 2-4 MUCH more closely. Keep the original soft illustrated cartoon style, transparent background, all 12 poses in the identical 4x3 layout; do not convert to pixel art. This is a distinctive grey/white Devon Rex-like cat: extremely LARGE tall pointy ears with thin pinkish inner ears, slender angular face, broad cheekbones, short muzzle, very short velvety fine grey coat (NOT long fluffy fur), slender neck and body, very long curling white whiskers, large pale yellow-green eyes, pink triangular nose. Narrow white blaze between eyes widens around nose into white muzzle/chin, broad white chest and white socks on otherwise grey legs. Tail fully grey without white tip. No stripes, accessories, environment or people. Keep expressive charm but reduce generic chubby kitten proportions and fluffy cheeks. Gentle neutral warm grey matching reference.
Exactly 4 columns x3 rows of equal cells, sprites safely INSIDE cells with generous transparent margins, no spillover. Row1 sitting front, standing left, standing rear, standing right. Row2 curled asleep, same curled asleep breathing variation, sitting half-closed sleepy eyes, same sitting head nod fully closed eyes. Row3 sitting tail raised curled LEFT, same sitting tail raised curled RIGHT with distinctly different tail placement, stretching front legs forward rear high, ONLY front face and two paws peeking. Same subject identity throughout. True alpha transparency with no ground shadow, no boxes, no text or grid.
```

### apricot-dog-pixel.png

```text
Create a production-ready desktop pet SPRITE SHEET of the user's small apricot/cream poodle in the photo references, as cute simple retro PIXEL ART. Same pet as photos: pale warm apricot tightly curly coat, fluffy round cream topknot, long drooping apricot ears, round dark eyes, dark brown/black nose with slight rosy top, pale cream muzzle and WHITE/cream chest, little paws, short upright curled pom tail. No cat ears. No collar, harness, leash, accessories, people, seat, scenery. Use flat limited palette, dark warm-charcoal pixel outline, chunky square pixels, not detailed fur/painting/vector/3D. Readable tiny desktop companion matching the visual scale of the reference pixel-cat sheet (last image, STYLE ONLY). Do not depict the cat.
Transparent canvas with EXACTLY 4 equal columns and 3 equal rows, 12 isolated sprite frames. Generous 18% empty margin in every cell, no sprite touches cell boundaries, consistent body/head scale across poses. No labels or borders, no ground shadow, genuine alpha transparency no checkerboard.
Row 1: sitting facing front happy idle; standing facing LEFT; standing REAR away from viewer; standing facing RIGHT.
Row 2: curled on floor asleep face on paws eyes closed; same sleep pose slight breathing variation; sitting dozing half closed eyes; same seated pose nodding off eyes closed.
Row 3: front sitting tail raised and wagged LEFT; same front sitting tail wagged RIGHT clearly different; stretching forelegs forward rump raised play-bow; ONLY poodle front head/face and two tiny front paws beneath chin for peeking over edge.
Keep this one dog's identity throughout. Cell grid must be regular with real blank padding between sprites.
```

### apricot-dog-comic.png

```text
Create ONE illustrated cartoon desktop-pet sprite sheet showing the user's small apricot poodle from photos 1-3. Match its identity: pale warm apricot curly coat, big fluffy rounded cream topknot, long droopy darker apricot ears, large dark brown-black expressive eyes, round dark nose with a slight rose-brown top, cream-white muzzle and broad white fluffy chest, little paws, short raised curly pom tail. Happy gentle expression. No collar/harness/leash, no people, scenery or accessories. Style should match the soft cartoon illustration in image4 (cat sheet, STYLE ONLY): refined dark outlines and soft cartoon shading, cute proportions, readable at96px. Do not draw any cats.
Transparent alpha sheet EXACTLY 4columns x3rows of equal cells, 12 frames, consistent same individual and body/head scale. Every character completely inside its cell with 18% clear margin, no overlaps, no border, no labels/text, no ground shadows, no checkerboard.
Row1: front sitting idle; standing facing left; standing away rearview; standing facing right.
Row2: curled asleep head lying on paws eyes closed; same asleep slightly expanded breathing; sitting sleepy eyes half closed; same pose head nodded with closed eyes.
Row3: front sitting tail wagged conspicuously LEFT of body; same sitting tail wagged conspicuously RIGHT of body (visibly different tail positions); full-body stretch playbow forepaws forward rump high; ONLY front head and two small paws below chin, for peeking from screen edge.
The dog must be pale apricot cream like reference rather than red brown. Keep all sprites isolated with true transparency.
```

[使用和验证](README.md) · [文档索引](../README.md)

