# Jogo na web (uso local)

A ROM **não vai para o Git** — só fica em `games/roms/` no seu computador ou no servidor que você controla.

## Donkey Kong Country

1. Copie o seu `.sfc` para:
   `games/roms/donkey-kong-country-usa.sfc`
2. Na pasta do projeto:
   `python -m http.server 8765`
3. Abra `http://127.0.0.1:8765/` e use **Jogar** ou **Continuar**.

**Continuar** restaura o save do cartucho (SRAM) e, se existir, o último **Salvar rápido**.

Só publique na internet ROMs que você tem direito de distribuir.
