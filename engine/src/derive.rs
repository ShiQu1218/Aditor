use crate::{
    detect::same_name,
    models::{Event, NameSig, SpecInterval, COUNTING_TYPES},
    profile::Profile,
};
use std::collections::VecDeque;

pub fn sig_similar(a: Option<&str>, b: Option<&str>, threshold: f64) -> bool {
    let a = a.and_then(|s| NameSig::from_b64(s).ok());
    let b = b.and_then(|s| NameSig::from_b64(s).ok());
    same_name(a.as_ref(), b.as_ref(), threshold)
}

pub fn is_counted(event: &Event) -> bool {
    !event.deleted && event.counted_override.unwrap_or(event.counted)
}

fn decoded<'a>(
    cache: &'a mut VecDeque<(String, Option<NameSig>)>,
    value: &str,
) -> &'a Option<NameSig> {
    let item = cache
        .iter()
        .position(|(key, _)| key == value)
        .and_then(|i| cache.remove(i))
        .unwrap_or_else(|| (value.to_owned(), NameSig::from_b64(value).ok()));
    cache.push_front(item);
    cache.truncate(256);
    &cache[0].1
}

pub fn derive(events: &[Event], spectating: &[SpecInterval], profile: &Profile) -> Vec<Event> {
    let mut result = events.to_vec();
    result.sort_by(|a, b| a.t.total_cmp(&b.t));
    let mut first: VecDeque<(f64, NameSig)> = VecDeque::new();
    let mut signatures = VecDeque::new();
    for event in &mut result {
        let reason = if event.deleted {
            "deleted"
        } else if event.kind == "death" {
            "death"
        } else if !COUNTING_TYPES.contains(&event.kind.as_str()) {
            "not_counting_type"
        } else if spectating
            .iter()
            .any(|s| s.start <= event.t && event.t < s.end)
        {
            "spectating"
        } else {
            while first
                .front()
                .is_some_and(|(t, _)| event.t - t > profile.dedupe_window)
            {
                first.pop_front();
            }
            let sig = event
                .name_sig
                .as_ref()
                .and_then(serde_json::Value::as_str)
                .and_then(|s| decoded(&mut signatures, s).as_ref());
            // A new knock can follow a revive; continuous banner frames are merged by EventTracker.
            if !matches!(event.kind.as_str(), "knock" | "assist_knock")
                && sig.as_ref().is_some_and(|sig| {
                    first.iter().any(|(t, s)| {
                        event.t >= *t
                            && event.t - t <= profile.dedupe_window
                            && same_name(Some(s), Some(sig), profile.name_sig_threshold)
                    })
                })
            {
                "duplicate"
            } else {
                if let Some(sig) = sig {
                    first.push_back((event.t, sig.clone()));
                }
                "first"
            }
        };
        event.counted = reason == "first";
        event.counted_reason = reason.into();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_cache_reuses_decodes_and_evicts_least_recently_used() {
        let mut cache = VecDeque::new();
        let sig = NameSig {
            width: 1,
            bits: vec![1; 16],
        }
        .to_b64();
        let bits = decoded(&mut cache, &sig).as_ref().unwrap().bits.as_ptr();
        for i in 0..255 {
            assert!(decoded(&mut cache, &format!("invalid-{i}")).is_none());
        }
        assert_eq!(
            decoded(&mut cache, &sig).as_ref().unwrap().bits.as_ptr(),
            bits
        );
        decoded(&mut cache, "new-invalid");
        assert_eq!(cache.len(), 256);
        assert!(!cache.iter().any(|(key, _)| key == "invalid-0"));
        assert!(cache.iter().any(|(key, _)| key == &sig));
    }
}
