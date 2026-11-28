# App Store screenshots

These portrait PNGs show Book Club on the local demo with a fictional club and member names. The library uses public-domain Project Gutenberg books. The player uses the LibriVox recording of *Alice’s Adventures in Wonderland*. The Cal screen uses a local model stand-in with a citation from Chapter 1 of the real book. Every file is an opaque RGB PNG.

| Screen | iPhone 6.9-inch · 1320 × 2868 | iPad 13-inch · 2064 × 2752 |
| --- | --- | --- |
| Library | [01-library.png](iphone-6.9/01-library.png) | [01-library.png](ipad-13/01-library.png) |
| Player with timed words | [02-player.png](iphone-6.9/02-player.png) | [02-player.png](ipad-13/02-player.png) |
| Club chat | [03-chat.png](iphone-6.9/03-chat.png) | [03-chat.png](ipad-13/03-chat.png) |
| Cal answer with a citation | [04-cal.png](iphone-6.9/04-cal.png) | [04-cal.png](ipad-13/04-cal.png) |
| Club search | [05-search.png](iphone-6.9/05-search.png) | [05-search.png](ipad-13/05-search.png) |

## Capture the views again

Run the demo with the LibriVox Alice fixture. In Playwright WebKit, use portrait mobile contexts at 440 × 956 CSS pixels with device scale factor 3 and 1032 × 1376 CSS pixels with device scale factor 2. Use a light appearance. Take viewport PNGs at device scale after the UI and fonts load. Encode them as opaque RGB PNGs without resizing.

1. Open the club library with three demo books and a saved place in *Alice*.
2. Open Alice’s audiobook. Show words at 0:45 in Chapter 1 and scroll until the highlighted word and playback controls are both visible.
3. Open the club’s General chat with a short conversation about starting the book.
4. Open Ask Cal from the Alice book page. Use a loopback model stand-in and full-text search. Allow AI access on the demo account and ask “What does Alice see when she looks down the well?” Have the stand-in search for “well was very deep” and “too dark to see anything” and cite the Chapter 1 passage starting “Either the well was very deep.” The demo answer is “She looks down as she falls, but it’s too dark to see what’s below.” Set the conversation title to “Into the rabbit-hole” through the conversation API, then reopen it for capture.
5. Return to the library and search for “Alice” in the club. Wait for the book and chat results.

[Apple’s screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
