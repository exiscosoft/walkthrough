# walkthrough-speech

Python sidecar spawned by the `walkthrough` CLI for `narrate`, `voice test` and `bench speech`.
Each engine gets its own virtualenv so torch / MLX pins cannot conflict:

```sh
./setup.sh chatterbox   # PyTorch MPS, MIT
./setup.sh f5           # f5-tts-mlx (weights CC-BY-NC: licence review before commercial use)
./setup.sh mlxaudio     # mlx-audio umbrella (licence varies per model)
./setup.sh align        # mlx-whisper, used for caption alignment and WER
```

The process reads one JSON object per line on stdin and writes one per line on stdout.
It exits on `{"cmd":"exit"}` or EOF, which releases all model memory.
