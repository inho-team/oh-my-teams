pipeline {
    agent none

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
        skipDefaultCheckout(true)
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    stages {
        stage('Linux Node 22') {
            agent { label 'docker' }
            steps {
                sh 'git config --global core.autocrlf false'
                checkout scm
                sh 'node --version && npm ci'
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm run quality' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm run format:check' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm test' }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }

        stage('macOS Node 22') {
            agent { label 'macmini' }
            environment {
                PATH = "/opt/homebrew/bin:${env.PATH}"
            }
            steps {
                sh 'git config --global core.autocrlf false'
                checkout scm
                sh 'node --version && npm ci'
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm run quality' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm run format:check' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { sh 'npm test' }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }

        stage('Windows Node 22') {
            agent { label 'windows' }
            environment {
                PATH = "C:\\Users\\kjsun\\AppData\\Local\\JenkinsAgent\\node22\\node-v22.23.2-win-x64;${env.PATH}"
            }
            steps {
                bat 'git config --global core.autocrlf false'
                checkout scm
                bat 'node --version && call npm.cmd ci'
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { bat 'call npm.cmd run quality' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { bat 'call npm.cmd run format:check' }
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') { bat 'call npm.cmd test' }
            }
            post { always { cleanWs(deleteDirs: true, notFailBuild: true) } }
        }
    }
}
