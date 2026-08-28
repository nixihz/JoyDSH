use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const MAX_RECENT_PROJECTS: usize = 12;

#[derive(Default, Deserialize, Serialize)]
struct WorkspaceCatalogData {
    base_directory: Option<PathBuf>,
    recent_projects: Vec<PathBuf>,
    #[serde(default)]
    project_permissions: HashMap<PathBuf, WorkspacePermissionMode>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WorkspacePermissionMode {
    #[default]
    Standard,
    FullAccess,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProject {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) recent: bool,
    pub(crate) permission_mode: WorkspacePermissionMode,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCatalogView {
    pub(crate) base_directory: Option<String>,
    pub(crate) projects: Vec<WorkspaceProject>,
}

pub(crate) struct WorkspaceCatalogStore {
    config_path: PathBuf,
}

impl WorkspaceCatalogStore {
    pub(crate) fn new(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    pub(crate) fn set_base_directory(&self, path: &Path) -> Result<(), String> {
        let directory = canonical_directory(path)?;
        let mut data = self.load()?;
        data.base_directory = Some(directory);
        self.save(&data)
    }

    #[cfg(test)]
    pub(crate) fn create_project(&self, name: &str) -> Result<PathBuf, String> {
        self.create_project_with_permission(name, WorkspacePermissionMode::Standard)
    }

    pub(crate) fn create_project_with_permission(
        &self,
        name: &str,
        permission_mode: WorkspacePermissionMode,
    ) -> Result<PathBuf, String> {
        validate_project_name(name)?;
        let mut data = self.load()?;
        let base = data.base_directory.as_ref().ok_or("请先设置工作区根目录")?;
        let project = base.join(name);
        fs::create_dir(&project).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "同名项目已存在，请直接选择它".to_string()
            } else {
                format!("无法创建项目文件夹：{error}")
            }
        })?;
        let project = canonical_directory(&project)?;
        remember(&mut data, project.clone());
        data.project_permissions
            .insert(project.clone(), permission_mode);
        self.save(&data)?;
        Ok(project)
    }

    #[cfg(test)]
    pub(crate) fn recent_projects(&self) -> Result<Vec<PathBuf>, String> {
        Ok(self.load()?.recent_projects)
    }

    #[cfg(test)]
    pub(crate) fn remember_project(&self, path: &Path) -> Result<(), String> {
        let project = canonical_directory(path)?;
        let mut data = self.load()?;
        remember(&mut data, project);
        self.save(&data)
    }

    pub(crate) fn remember_project_with_permission(
        &self,
        path: &Path,
        permission_mode: WorkspacePermissionMode,
    ) -> Result<(), String> {
        let project = canonical_directory(path)?;
        let mut data = self.load()?;
        remember(&mut data, project.clone());
        data.project_permissions.insert(project, permission_mode);
        self.save(&data)
    }

    pub(crate) fn view(&self) -> Result<WorkspaceCatalogView, String> {
        let data = self.load()?;
        let mut projects = Vec::new();
        let mut paths = Vec::new();
        for path in &data.recent_projects {
            if !path.is_dir() {
                continue;
            }
            let permission_mode = data
                .project_permissions
                .get(path)
                .copied()
                .unwrap_or_default();
            push_project(
                &mut projects,
                &mut paths,
                path.clone(),
                true,
                permission_mode,
            );
        }
        if let Some(base) = &data.base_directory {
            let mut children = fs::read_dir(base)
                .map_err(|error| format!("无法读取工作区根目录：{error}"))?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with('.') || !entry.file_type().ok()?.is_dir() {
                        return None;
                    }
                    fs::canonicalize(entry.path()).ok()
                })
                .collect::<Vec<_>>();
            children.sort_by_key(|path| project_name(path).to_lowercase());
            for child in children {
                let permission_mode = data
                    .project_permissions
                    .get(&child)
                    .copied()
                    .unwrap_or_default();
                push_project(&mut projects, &mut paths, child, false, permission_mode);
            }
        }
        Ok(WorkspaceCatalogView {
            base_directory: data
                .base_directory
                .map(|path| path.to_string_lossy().into_owned()),
            projects,
        })
    }

    fn load(&self) -> Result<WorkspaceCatalogData, String> {
        if !self.config_path.exists() {
            return Ok(WorkspaceCatalogData::default());
        }
        let contents = fs::read_to_string(&self.config_path)
            .map_err(|error| format!("无法读取工作区配置：{error}"))?;
        serde_json::from_str(&contents).map_err(|error| format!("工作区配置已损坏：{error}"))
    }

    fn save(&self, data: &WorkspaceCatalogData) -> Result<(), String> {
        let parent = self.config_path.parent().ok_or("工作区配置路径无效")?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建工作区配置目录：{error}"))?;
        let contents = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
        let temporary = self.config_path.with_extension("json.tmp");
        fs::write(&temporary, contents).map_err(|error| format!("无法写入工作区配置：{error}"))?;
        fs::rename(&temporary, &self.config_path)
            .map_err(|error| format!("无法保存工作区配置：{error}"))
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let directory = fs::canonicalize(path).map_err(|error| format!("文件夹不可用：{error}"))?;
    if !directory.is_dir() {
        return Err("选择的路径不是文件夹".into());
    }
    Ok(directory)
}

fn validate_project_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("请输入项目名".into());
    }
    if name != name.trim() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return Err("项目名只能是单层文件夹名称".into());
    }
    Ok(())
}

fn remember(data: &mut WorkspaceCatalogData, project: PathBuf) {
    data.recent_projects
        .retain(|candidate| candidate != &project);
    data.recent_projects.insert(0, project);
    data.recent_projects.truncate(MAX_RECENT_PROJECTS);
}

fn push_project(
    projects: &mut Vec<WorkspaceProject>,
    paths: &mut Vec<PathBuf>,
    path: PathBuf,
    recent: bool,
    permission_mode: WorkspacePermissionMode,
) {
    if paths.contains(&path) {
        return;
    }
    let name = project_name(&path);
    projects.push(WorkspaceProject {
        name,
        path: path.to_string_lossy().into_owned(),
        recent,
        permission_mode,
    });
    paths.push(path);
}

fn project_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{WorkspaceCatalogStore, WorkspacePermissionMode};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("joydsh-workspace-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_a_project_folder_and_persists_it_as_recent() {
        let temporary = TestDirectory::new();
        let base = temporary.0.join("workspaces");
        fs::create_dir(&base).unwrap();
        let store = WorkspaceCatalogStore::new(temporary.0.join("catalog.json"));

        store.set_base_directory(&base).unwrap();
        let project = store.create_project("电视项目").unwrap();

        assert_eq!(project, fs::canonicalize(&base).unwrap().join("电视项目"));
        assert!(project.is_dir());
        assert_eq!(
            WorkspaceCatalogStore::new(temporary.0.join("catalog.json"))
                .recent_projects()
                .unwrap(),
            vec![project],
        );
    }

    #[test]
    fn rejects_path_traversal_and_prioritizes_recent_projects() {
        let temporary = TestDirectory::new();
        let base = temporary.0.join("workspaces");
        let external = temporary.0.join("outside");
        fs::create_dir(&base).unwrap();
        fs::create_dir(&external).unwrap();
        fs::create_dir(base.join("Alpha")).unwrap();
        fs::create_dir(base.join("Zeta")).unwrap();
        let store = WorkspaceCatalogStore::new(temporary.0.join("catalog.json"));
        store.set_base_directory(&base).unwrap();

        assert_eq!(
            store.create_project("../escape").unwrap_err(),
            "项目名只能是单层文件夹名称"
        );
        store.remember_project(&external).unwrap();
        store.remember_project(&base.join("Zeta")).unwrap();

        let view = store.view().unwrap();
        assert_eq!(
            view.projects
                .iter()
                .map(|project| project.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Zeta", "outside", "Alpha"],
        );
        assert_eq!(
            view.projects
                .iter()
                .map(|project| project.recent)
                .collect::<Vec<_>>(),
            vec![true, true, false],
        );
    }

    #[test]
    fn persists_full_access_as_an_explicit_project_default() {
        let temporary = TestDirectory::new();
        let project = temporary.0.join("project");
        fs::create_dir(&project).unwrap();
        let store = WorkspaceCatalogStore::new(temporary.0.join("catalog.json"));

        store
            .remember_project_with_permission(&project, WorkspacePermissionMode::FullAccess)
            .unwrap();

        let view = WorkspaceCatalogStore::new(temporary.0.join("catalog.json"))
            .view()
            .unwrap();
        assert_eq!(
            view.projects[0].permission_mode,
            WorkspacePermissionMode::FullAccess,
        );
        assert_eq!(
            serde_json::to_value(&view).unwrap()["projects"][0]["permissionMode"],
            "full-access",
        );
    }

    #[test]
    fn defaults_projects_from_legacy_catalogs_to_standard_permission() {
        let temporary = TestDirectory::new();
        let project = temporary.0.join("legacy-project");
        fs::create_dir(&project).unwrap();
        let project = fs::canonicalize(project).unwrap();
        let config_path = temporary.0.join("catalog.json");
        fs::write(
            &config_path,
            serde_json::to_vec(&serde_json::json!({
                "base_directory": null,
                "recent_projects": [project],
            }))
            .unwrap(),
        )
        .unwrap();

        let view = WorkspaceCatalogStore::new(config_path).view().unwrap();

        assert_eq!(
            view.projects[0].permission_mode,
            WorkspacePermissionMode::Standard,
        );
        assert_eq!(
            serde_json::to_value(&view).unwrap()["projects"][0]["permissionMode"],
            "standard",
        );
    }

    #[test]
    fn create_and_remember_persist_the_latest_explicit_permission() {
        let temporary = TestDirectory::new();
        let base = temporary.0.join("workspaces");
        fs::create_dir(&base).unwrap();
        let config_path = temporary.0.join("catalog.json");
        let store = WorkspaceCatalogStore::new(config_path.clone());
        store.set_base_directory(&base).unwrap();

        let project = store
            .create_project_with_permission("project", WorkspacePermissionMode::FullAccess)
            .unwrap();
        assert_eq!(
            WorkspaceCatalogStore::new(config_path.clone())
                .view()
                .unwrap()
                .projects[0]
                .permission_mode,
            WorkspacePermissionMode::FullAccess,
        );

        store
            .remember_project_with_permission(&project, WorkspacePermissionMode::Standard)
            .unwrap();
        let view = WorkspaceCatalogStore::new(config_path).view().unwrap();
        assert_eq!(
            view.projects[0].permission_mode,
            WorkspacePermissionMode::Standard,
        );
        assert_eq!(
            serde_json::to_value(&view).unwrap()["projects"][0]["permissionMode"],
            "standard",
        );
    }
}
