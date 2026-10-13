# Ichigo Jam Face Match 🍓

An event screen that reads everyone's facial expression from the webcam and nudges them toward the same emotion.
English and Japanese throughout.

Hands-free: once the camera is allowed it runs on its own.

- **Rounds run automatically**, cycling through:
  - お題 · everyone shows the same target emotion (happy, surprised, sad or angry)
  - バラバラ · each person gets a different emotion, e.g. P1 sad, P2 angry (2+ people)
  - まねっこ · copy each other's face (2+ people)

  A round that nobody wins is skipped after 30 s.

- **The jam jar fills** while everyone holds the match; when it's full there's a celebration with strawberry confetti and the score goes up.

Keys (for the operator): **S** settings · **F** fullscreen (or double-click) · **N** next round.
Settings (game type, hold time, sensitivity, round timeout, neutral rule, reset score) are saved in the browser.

Everything runs locally in the browser (face-api / TensorFlow.js, models in `public/models`).
Nothing is uploaded. The rounded font loads from Google Fonts and falls back to the system font offline.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173, allow camera access, press **F** for full screen.

Testing without a camera: `http://localhost:5173/?testImage=<image url>` uses a still image instead.

## Demo

Live at https://prohaller.github.io/ichigo-face-match/ — deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push to `main`.
One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

## Saved success photos

Every win captures the complete victory card as a PNG in memory only. No automatic downloads occur.
The clean camera photo, strawberry frame, bilingual celebration and emotion targets, branding,
score and time are included. The export is upright with animations frozen.

Open settings with **S**, then choose **Download pictures** to save every captured card in one archive.
Cards remain in memory for repeat downloads. Filenames include the time, score, game and emotion goals.
New wins after an export are marked as not downloaded.

Closing, navigating away or reloading with cards not yet downloaded (or a capture in progress) triggers
the browser's standard leave-page warning. Choose to stay, then download from settings.
Browsers do not allow custom wording or a download button in that warning, and may suppress it
without prior user interaction. It cannot protect against crashes or force-quitting.
The warning clears once the ZIP download starts; check that it finished saving before closing.
Cards are not persisted across reloads or sessions.
