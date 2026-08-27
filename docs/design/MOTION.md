# Motion Spec

- Page content: 220ms fade + 6px rise
- Cards/list rows: 260ms fade + 4px rise
- Buttons: 140ms press response, ~0.98 scale
- Home tiles: ~0.97 press scale
- Floating Add: restrained press response only
- Assistant working sparkle: soft alternating scale/rotation; never continuous for reduced-motion users
- Success: use stable applied state plus toast; no confetti by default
- Never pulse warnings
- `prefers-reduced-motion: reduce` disables decorative animations/transitions
