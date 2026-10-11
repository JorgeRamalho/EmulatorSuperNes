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

## Publicar online (página estática)

O site é só arquivos estáticos (`index.html`, `donkey-kong.html`, `vendor/`, `games/manifest.json` e a ROM em `games/roms/`).

1. Confirme a ROM em `games/roms/donkey-kong-country-usa.sfc`.
2. Teste local: `python -m http.server 8765` → [http://127.0.0.1:8765/donkey-kong.html](http://127.0.0.1:8765/donkey-kong.html) (o jogo inicia sozinho).
3. **Netlify** (recomendado, a ROM entra no upload da pasta):
   - Instale o [Netlify CLI](https://docs.netlify.com/cli/get-started/).
   - Na pasta do projeto: `npx netlify deploy --dir=. --prod`
   - A ROM ignorada pelo Git **ainda vai** no deploy feito da sua máquina.
4. **GitHub Pages** a partir do repositório **não** envia a ROM (`.gitignore`). Use Netlify/Cloudflare Pages com deploy da pasta local, ou um repositório privado com a ROM versionada se você tiver direito de hospedar.

Na primeira execução no navegador, o Nostalgist baixa o núcleo snes9x da internet; depois usa cache.
