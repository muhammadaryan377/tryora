# Image model test

Compares image models on the same room and product photos, on four points: quality, cost per image, speed, and how often generation fails.

This has to run on your laptop. Claude's cloud workspace can't reach the OpenAI or Google APIs.

## One-time setup
1. Install Node.js 22 or newer from nodejs.org.
2. Put your keys in `TRYORA\.env`. Use `.env.example` as the template. Don't paste the keys in chat.

## Add test cases
Each case is a folder in `tools/model-test/inputs/`. For example:

```
inputs/
  01-bedroom-replace/
    room.jpg          your own room photo (keep it on your computer)
    product1.jpg      product photo, front view
    product2.jpg      optional extra angle
    case.json
```

`case.json`:
```json
{ "product": "Egerie curved headboard bed in beige boucle", "option": "Beige boucle", "placement": "replace", "target": "the existing bed" }
```

Use `"placement": "place"` for an empty room. Aim for 5–8 cases: bright and dim rooms, straight-on and angled shots, one empty room, and a dark-colour option.

## Run
From the `TRYORA\code` folder:
```
node tools/model-test/run.mjs
node tools/model-test/run.mjs --runs 2
node tools/model-test/run.mjs --models gemini-2.5-flash-image,openai-gpt-image-2
node tools/model-test/run.mjs --list-gemini
```
Each run writes to `tools/model-test/output/<time>/`. You get the images, `results.csv`, and `report.html`, which shows the results side by side.

Score each image from 1 to 5 on four points:
- the product matches
- the colour matches
- the room is left unchanged
- it looks realistic

Before relying on the prices, check them on the official pricing pages. Retention terms decide which provider we can use at all, and that question is in docs/decisions.md.
