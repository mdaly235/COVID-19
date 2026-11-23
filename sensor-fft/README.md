# Sensor FFT

A phone web app that runs a live Fast Fourier Transform on signals from your
phone's sensors and shows the waveform, the spectrum and a scrolling spectrogram.
It has no dependencies and no build step, and all processing happens on the phone.

## Sources

| Source | API | Typical sample rate | Highest frequency shown (Nyquist) |
|---|---|---|---|
| Microphone | Web Audio (`getUserMedia`) | 44.1 / 48 kHz | 22–24 kHz |
| Accelerometer (with gravity) | Generic Sensor API, falls back to `devicemotion` | 60–200 Hz | 30–100 Hz |
| Linear acceleration (gravity removed) | same | 60–200 Hz | 30–100 Hz |
| Gyroscope | same | 60–200 Hz | 30–100 Hz |
| Magnetometer | Generic Sensor API (Android Chrome, behind a flag) | ~60 Hz | ~30 Hz |
| Test signal | synthetic: tones, a chirp, beating | 1 kHz | 500 Hz |

The motion sensors give X, Y, Z and magnitude channels. Their real sample rate
is measured from event timestamps and used for the frequency axis.

## Features

- Radix-2 FFT, sizes 64 to 32768 (`fft.js`)
- Windows: Hann, Hamming, Blackman, flat top and rectangular. Amplitudes are
  corrected for the window's gain, so a sine of amplitude A shows a peak of
  about A, in the sensor's own units.
- DC and gravity removal, exponential averaging, adjustable dynamic range
- Linear or logarithmic frequency axis, with an optional maximum frequency
- The 5 strongest peaks, refined between bins with parabolic interpolation. The
  readout shows the dominant frequency, period and amplitude, plus the musical
  note for the microphone.
- Tap the spectrum to read the frequency and level at any point.
- Freeze, and CSV export of the spectrum or the raw waveform
- Installable as an app (PWA), works offline, and keeps the screen on while running

## Running it on your phone

Browsers only allow microphone and motion-sensor access on **https** pages,
so the app has to be served over HTTPS.

**GitHub Pages (easiest):** in the repository's Settings → Pages, deploy from this
branch, then open `https://<user>.github.io/<repo>/sensor-fft/` on your phone.
Use the browser's *Add to Home Screen* to install it.

**From a computer on your network:** run `python3 -m http.server 8000` in this
folder, then reach it over HTTPS through a tunnel (for example
`npx localtunnel --port 8000` or `cloudflared tunnel --url http://localhost:8000`).

On iPhone, Safari asks for motion permission when you tap **Start**.

## Tips

- Motion sensors: lay the phone on a washing machine, a car dashboard or a
  fan to see its vibration frequency. Use *Linear acceleration*, or keep
  *Remove DC* on, to get rid of gravity.
- Δf (frequency resolution) = sample rate ÷ FFT size. A larger FFT resolves
  closer frequencies but reacts more slowly.
- Use the flat-top window for accurate amplitudes and Hann for everything else.
- Phone microphones filter out frequencies below about 20–50 Hz.

## Files

- `index.html`: layout and styles
- `app.js`: user interface, render loop, plots, export
- `fft.js`: FFT, windows, spectrum scaling, peak finding
- `sources.js`: microphone, motion sensors and test signal behind one interface
- `sw.js`, `manifest.json`, `icon.svg`: offline support and installation
