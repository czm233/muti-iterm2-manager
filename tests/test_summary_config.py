from __future__ import annotations

from multi_iterm2_manager.config import is_masked_secret, load_settings, mask_secret


def test_summary_api_key_mask_detection() -> None:
    assert mask_secret("1234567890abcdef") == "12345678..."
    assert is_masked_secret("12345678...")
    assert not is_masked_secret("")
    assert not is_masked_secret("1234567890abcdef")
    assert not is_masked_secret("sk-12345678...")


def test_masked_summary_api_key_falls_back_to_env(tmp_path, monkeypatch) -> None:
    settings_file = tmp_path / "ui-settings.yaml"
    settings_file.write_text(
        "\n".join(
            [
                "ui:",
                "  summary_api_base: https://example.test/api",
                "  summary_api_key: 12345678...",
                "  summary_model: test-model",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MITERM_UI_SETTINGS_FILE", str(settings_file))
    monkeypatch.setenv("MITERM_SUMMARY_API_KEY", "real-secret-key")

    settings = load_settings()

    assert settings.summary_api_key == "real-secret-key"
    assert settings.ui_settings.summary_api_key == "real-secret-key"


def test_masked_summary_api_key_is_cleared_without_env(tmp_path, monkeypatch) -> None:
    settings_file = tmp_path / "ui-settings.yaml"
    settings_file.write_text(
        "\n".join(
            [
                "ui:",
                "  summary_api_base: https://example.test/api",
                "  summary_api_key: 12345678...",
                "  summary_model: test-model",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MITERM_UI_SETTINGS_FILE", str(settings_file))
    monkeypatch.delenv("MITERM_SUMMARY_API_KEY", raising=False)

    settings = load_settings()

    assert settings.summary_api_key == ""
    assert settings.ui_settings.summary_api_key == ""
