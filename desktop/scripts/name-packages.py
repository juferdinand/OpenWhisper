"""Keep GTK desktop identity exact while giving downloads a readable product name."""
from pathlib import Path

bundle = Path(__file__).resolve().parents[1] / "target/release/bundle"
for folder, suffix in [("deb", ".deb"), ("appimage", ".AppImage")]:
    packages = list((bundle / folder).glob(f"io.github.whisperfree_*{suffix}"))
    assert len(packages) == 1, f"Expected one {suffix} package, found {len(packages)}"
    package = packages[0]
    target = package.with_name(package.name.replace("io.github.whisperfree_", "WhisperFree_", 1))
    package.replace(target)
    print(target.name)
