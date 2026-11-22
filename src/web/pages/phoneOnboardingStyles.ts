export const phoneOnboardingStyles = `
  .phone-onboarding {
    background: var(--color-background-surface);
    padding-inline: clamp(var(--spacing-4), 5vw, var(--spacing-10));
  }
  .phone-onboarding .phone-wordmark {
    font: 500 2rem/1 "Iowan Old Style", Georgia, serif;
    letter-spacing: -.04em;
    color: var(--color-text-primary);
  }
  .phone-stage {
    flex: 1;
    padding-block: var(--spacing-3);
  }
  .phone-onboarding .phone-panel {
    position: relative;
    isolation: isolate;
    border: var(--border-width) solid var(--color-border-emphasized);
    border-radius: var(--radius-container);
    overflow: clip;
  }
  .phone-plate {
    margin: 0;
    padding: var(--spacing-3);
    background: light-dark(
      color-mix(in srgb, var(--color-success-muted) 14%, var(--color-background-body)),
      color-mix(in srgb, var(--color-on-dark) 92%, var(--color-success))
    );
  }
  .phone-plate img {
    display: block;
    width: 100%;
    height: clamp(7.5rem, 23svh, 13rem);
    object-fit: contain;
    mix-blend-mode: multiply;
    animation: phone-appear 240ms ease-out;
  }
  .phone-content {
    min-width: 0;
    padding: clamp(var(--spacing-4), 4vw, var(--spacing-8));
    text-align: center;
  }
  .phone-content .phone-heading {
    font: 500 clamp(2.35rem, 7vw, 3.3rem)/1.04 "Iowan Old Style", Georgia, serif;
    letter-spacing: -.035em;
    overflow-wrap: break-word;
    outline: none;
  }
  .phone-content .phone-description {
    max-width: 42ch;
    font-size: 1.05rem;
    line-height: 1.55;
    text-wrap: balance;
  }
  .phone-progress i {
    width: var(--spacing-4);
    height: var(--spacing-1);
    border-radius: var(--radius-full);
    background: var(--color-border-emphasized);
  }
  .phone-progress [data-filled="true"] { background: var(--color-text-primary); }
  .phone-done { color: var(--color-text-success); }
  .phone-form { width: 100%; max-width: 23rem; }
  .phone-form .astryx-field-label { justify-content: center; text-align: center; }
  .phone-consent > :first-child { flex-direction: column; }
  .phone-consent .astryx-checkbox-label { text-wrap: balance; }
  .phone-number label, .phone-privacy summary { margin-inline: auto; }
  .phone-number input { text-align: center; }
  .phone-content button[data-size="lg"] { min-height: 2.75rem; }
  .phone-privacy { font-size: var(--text-supporting-size); color: var(--color-text-secondary); }
  .phone-privacy summary { cursor: pointer; width: fit-content; }
  .phone-privacy p { margin-top: var(--spacing-2); }
  .phone-confetti {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    container-type: size;
  }
  .phone-confetti i {
    position: absolute;
    top: calc(-1 * var(--spacing-4));
    width: var(--spacing-1-5);
    height: var(--spacing-3);
    background: var(--color-border-green);
    animation: phone-fall 2s ease-in both;
  }
  .phone-confetti i:nth-child(3n) { background: var(--color-border-yellow); }
  .phone-confetti i:nth-child(3n + 1) { background: var(--color-border-orange); }
  .phone-confetti i:nth-child(even) { border-radius: var(--radius-full); }
  @keyframes phone-appear {
    from { opacity: .6; transform: translateY(var(--spacing-1)); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes phone-fall {
    from { transform: translate(0, 0) rotate(0); }
    to { transform: translate(var(--drift), calc(100cqh + var(--spacing-8))) rotate(var(--spin)); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .phone-plate img, .phone-confetti i { animation: none; }
    .phone-confetti { display: none; }
  }
`;
