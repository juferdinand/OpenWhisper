use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use unicode_categories::UnicodeCategories;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Snippet {
    #[serde(default)]
    pub id: String,
    pub trigger: String,
    pub expansion: String,
    pub enabled: bool,
}

static NON_SPEECH: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(
    r"\[[^\]]*\]|\([^)]*(musik|music|applaus|applause|lacht|laughs|stille|silence|geräusch|noise)[^)]*\)|\*[^*]+\*"
).case_insensitive(true).build().unwrap()
});
static HALLUCINATION: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(
    r"(Untertitel(ung)?[^.]*?(ZDF|Amara\.org|funk)[^.]*\.?)|(Subtitles by the Amara\.org community\.?)"
).case_insensitive(true).build().unwrap()
});
static WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}][\p{L}\p{N}'’\-]*").unwrap());

pub fn clean(raw: &str) -> String {
    let text = NON_SPEECH.replace_all(raw, " ");
    let text = HALLUCINATION.replace_all(&text, " ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text
        .chars()
        .all(|c| c.is_whitespace() || c.is_punctuation())
    {
        String::new()
    } else {
        text
    }
}

fn normalize(text: &str) -> String {
    text.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

pub fn vocabulary_terms(text: &str) -> Vec<String> {
    text.split([',', ';', '\n', '\r'])
        .map(str::trim)
        .filter(|s| normalize(s).chars().count() >= 3)
        .map(str::to_owned)
        .collect()
}

fn similarity(a: &str, b: &str) -> f64 {
    let x: Vec<char> = a.chars().collect();
    let y: Vec<char> = b.chars().collect();
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let mut previous: Vec<usize> = (0..=y.len()).collect();
    for (i, a) in x.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, b) in y.iter().enumerate() {
            row.push(
                (previous[j + 1] + 1)
                    .min(row[j] + 1)
                    .min(previous[j] + usize::from(a != b)),
            );
        }
        previous = row;
    }
    1.0 - previous[y.len()] as f64 / x.len().max(y.len()) as f64
}

pub fn correct_vocabulary(text: &str, terms: &[String]) -> String {
    let words: Vec<_> = WORD.find_iter(text).collect();
    let mut matches = Vec::new();
    for term in terms {
        let key = normalize(term);
        let threshold = match key.chars().count() {
            0..=4 => 1.0,
            5..=7 => 0.84,
            _ => 0.8,
        };
        let window = (term
            .split(|c: char| c.is_whitespace() || c == '-')
            .filter(|s| !s.is_empty())
            .count()
            .max(1)
            + 1)
        .min(3);
        for start in 0..words.len() {
            for length in 1..=window.min(words.len() - start) {
                let candidate = words[start..start + length]
                    .iter()
                    .map(|m| m.as_str())
                    .collect::<String>();
                let score = similarity(&normalize(&candidate), &key);
                if score >= threshold {
                    matches.push((start, start + length - 1, term, score));
                }
            }
        }
    }
    matches.sort_by(|a, b| b.3.total_cmp(&a.3).then((b.1 - b.0).cmp(&(a.1 - a.0))));
    let mut used = vec![false; words.len()];
    let mut chosen = Vec::new();
    for m in matches {
        if !used[m.0..=m.1].iter().any(|v| *v) {
            used[m.0..=m.1].fill(true);
            chosen.push(m);
        }
    }
    chosen.sort_by_key(|m| std::cmp::Reverse(m.0));
    let mut output = text.to_owned();
    for (start, end, term, _) in chosen {
        output.replace_range(words[start].start()..words[end].end(), term);
    }
    output
}

fn trigger_pattern(trigger: &str) -> Option<Regex> {
    let parts: Vec<_> = trigger
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|s| !s.is_empty())
        .map(regex::escape)
        .collect();
    if parts.is_empty() {
        return None;
    }
    RegexBuilder::new(&parts.join(r"[\s\-]+"))
        .case_insensitive(true)
        .build()
        .ok()
}

pub fn expand_snippets(text: &str, snippets: &[Snippet]) -> String {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c.is_punctuation());
    for snippet in snippets.iter().filter(|s| s.enabled) {
        if let Some(pattern) = trigger_pattern(&snippet.trigger) {
            if pattern
                .find(trimmed)
                .is_some_and(|m| m.start() == 0 && m.end() == trimmed.len())
            {
                return snippet.expansion.clone();
            }
        }
    }
    let mut result = text.to_owned();
    for snippet in snippets.iter().filter(|s| s.enabled) {
        if let Some(pattern) = trigger_pattern(&snippet.trigger) {
            let ranges: Vec<_> = pattern
                .find_iter(&result)
                .filter(|m| {
                    !result[..m.start()]
                        .chars()
                        .next_back()
                        .is_some_and(char::is_alphanumeric)
                        && !result[m.end()..]
                            .chars()
                            .next()
                            .is_some_and(char::is_alphanumeric)
                })
                .map(|m| m.range())
                .collect();
            for range in ranges.into_iter().rev() {
                result.replace_range(range, &snippet.expansion);
            }
        }
    }
    result
}

pub fn process(text: &str, vocabulary: &str, snippets: &[Snippet]) -> String {
    expand_snippets(
        &correct_vocabulary(&clean(text), &vocabulary_terms(vocabulary)),
        snippets,
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Model {
    pub id: String,
    pub title: String,
    pub family: String,
    pub file: String,
    pub repository: String,
    pub size: String,
    pub note: String,
}

pub fn catalog() -> Vec<Model> {
    #[derive(Deserialize)]
    struct Catalog {
        models: Vec<Model>,
    }
    serde_json::from_str::<Catalog>(include_str!("../../../../shared/models.json"))
        .expect("valid embedded model catalog")
        .models
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_multilingual_vectors() {
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../../../../shared/test-vectors.json")).unwrap();
        for case in data["cleaner"].as_array().unwrap() {
            assert_eq!(
                clean(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        let terms = vocabulary_terms(data["vocabulary"]["terms"].as_str().unwrap());
        for case in data["vocabulary"]["cases"].as_array().unwrap() {
            assert_eq!(
                correct_vocabulary(case["input"].as_str().unwrap(), &terms),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        let snippets =
            serde_json::from_value::<Vec<Snippet>>(data["snippets"]["snippets"].clone()).unwrap();
        for case in data["snippets"]["cases"].as_array().unwrap() {
            assert_eq!(
                expand_snippets(case["input"].as_str().unwrap(), &snippets),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn english_and_unicode_text() {
        assert_eq!(clean("[BLANK_AUDIO] Hello  world (music)"), "Hello world");
        assert_eq!(
            correct_vocabulary(
                "Use Kubernetis and café",
                &vocabulary_terms("Kubernetes; Café")
            ),
            "Use Kubernetes and Café"
        );
        assert_eq!(clean("… — ."), "");
    }
    #[test]
    fn catalog_paths_are_safe() {
        let models = catalog();
        assert!(!models.is_empty());
        for m in models {
            assert!(!m.file.contains('/') && !m.file.contains('\\') && !m.file.contains(".."));
            assert!(matches!(m.family.as_str(), "whisper" | "parakeet"));
        }
    }
}
