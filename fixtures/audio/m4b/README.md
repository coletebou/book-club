# A single-file audiobook with chapters

`tale-in-three-chapters.m4b`: 12 seconds of a generated 330 Hz tone in AAC, with three chapter
markers (0 s, 4 s, 8 s) and title, artist and album tags. Generated, not recorded, so free of any
rights:

```sh
ffmpeg -f lavfi -i "sine=frequency=330:duration=12" -i meta.txt -map_metadata 1 -map_chapters 1 \
  -c:a aac -b:a 32k -ac 1 -f mp4 tale-in-three-chapters.m4b
```

where `meta.txt` is an FFMETADATA1 file with three `[CHAPTER]` entries (TIMEBASE=1/1000) titled
"Chapter One: The Start", "Chapter Two: The Middle" and "Chapter Three: The End".
